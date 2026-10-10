
const SUPABASE_URL = "https://qsuaqfqhzkqkcylkirpi.supabase.co";
const SUPABASE_KEY = "sb_publishable_3M7Mk3JR3aHHnzNaldCYsw_JLBo3EdS";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);

let currentUser = null;
let channel = null;
let loadingMessages = false;
let reloadPending = false;
let authVersion = 0;

function showNotice(text) {
  $("notice").textContent = text;
}

function showLogin() {
  authVersion++;
  currentUser = null;

  $("login").classList.remove("hidden");
  $("chat").classList.add("hidden");
  $("messages").replaceChildren();
  showNotice("");

  if (channel) {
    const oldChannel = channel;
    channel = null;
    void db.removeChannel(oldChannel);
  }
}

async function showChat(user) {
  if (currentUser?.id === user.id && channel) return;

  const version = ++authVersion;
  currentUser = user;

  $("login").classList.add("hidden");
  $("chat").classList.remove("hidden");
  $("status").textContent = "Private conversation";

  if (channel) {
    const oldChannel = channel;
    channel = null;
    await db.removeChannel(oldChannel);
  }

  if (version !== authVersion || !currentUser) return;

  await loadMessages();

  if (version !== authVersion || !currentUser) return;

  const newChannel = db.channel("private-chat-" + user.id);

  newChannel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "messages"
    },
    () => {
      void loadMessages();
    }
  );

  channel = newChannel;

  newChannel.subscribe(status => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      showNotice("Live connection interrupted. Refresh if messages stop updating.");
    } else if (status === "SUBSCRIBED") {
      showNotice("");
    }
  });
}

async function loadMessages() {
  if (!currentUser) return;

  if (loadingMessages) {
    reloadPending = true;
    return;
  }

  loadingMessages = true;
  const userId = currentUser.id;

  try {
    do {
      reloadPending = false;

      const { data, error } = await db
        .from("messages")
        .select("*")
        .order("created_at", { ascending: true })
        .limit(200);

      if (error) throw error;
      if (!currentUser || currentUser.id !== userId) return;

      const container = $("messages");
      const wasNearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 100;

      const fragment = document.createDocumentFragment();

      for (const message of data || []) {
        const item = document.createElement("article");
        item.className = "message";

        if (message.user_id === userId) {
          item.classList.add("mine");
        }

        const sender = document.createElement("div");
        sender.className = "sender";
        sender.textContent = message.user_id === userId ? "You" : "Friend";
        item.appendChild(sender);

        if (message.content) {
          const text = document.createElement("div");
          text.textContent = message.content;
          item.appendChild(text);
        }

        if (message.image_path) {
          const { data: image, error: imageError } = await db.storage
            .from("chat-images")
            .createSignedUrl(message.image_path, 3600);

          if (!currentUser || currentUser.id !== userId) return;

          if (!imageError && image?.signedUrl) {
            const img = document.createElement("img");
            img.src = image.signedUrl;
            img.alt = "Shared image";
            img.loading = "lazy";
            item.appendChild(img);
          }
        }

        const time = document.createElement("time");
        time.textContent = new Date(message.created_at).toLocaleString();
        item.appendChild(time);

        fragment.appendChild(item);
      }

      container.replaceChildren(fragment);

      if (wasNearBottom) {
        container.scrollTop = container.scrollHeight;
      }
    } while (reloadPending && currentUser?.id === userId);
  } catch (error) {
    showNotice(error.message || "Couldn't load messages.");
  } finally {
    loadingMessages = false;
  }
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("loginError").textContent = "";

  const { data, error } = await db.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value
  });

  if (error) {
    $("loginError").textContent = error.message;
    return;
  }

  if (data.user) {
    await showChat(data.user);
  }
});

$("messageForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!currentUser) return;

  const content = $("messageInput").value.trim();
  if (!content) return;

  const userId = currentUser.id;
  $("messageInput").disabled = true;
  showNotice("Sending...");

  try {
    const { error } = await db.from("messages").insert({
      user_id: userId,
      content
    });

    if (error) throw error;

    if (currentUser?.id !== userId) return;

    $("messageInput").value = "";
    showNotice("");
    await loadMessages();
  } catch (error) {
    showNotice(error.message || "Couldn't send message.");
  } finally {
    $("messageInput").disabled = false;
    $("messageInput").focus();
  }
});

$("imageInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";

  if (!file || !currentUser) return;

  const userId = currentUser.id;
  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ];

  if (!allowedTypes.includes(file.type)) {
    showNotice("Use a JPG, PNG, WEBP or GIF image.");
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showNotice("Images must be 5 MB or smaller.");
    return;
  }

  showNotice("Uploading image...");

  try {
    const extensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif"
    };

    const path = `${userId}/${crypto.randomUUID()}.${extensions[file.type]}`;

    const { error: uploadError } = await db.storage
      .from("chat-images")
      .upload(path, file, {
        contentType: file.type,
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { error: messageError } = await db.from("messages").insert({
      user_id: userId,
      content: "",
      image_path: path
    });

    if (messageError) throw messageError;

    if (currentUser?.id !== userId) return;

    showNotice("");
    await loadMessages();
  } catch (error) {
    showNotice(error.message || "Couldn't upload image.");
  }
});

$("logout").addEventListener("click", async () => {
  const { error } = await db.auth.signOut();

  if (error) {
    showNotice(error.message);
  }
});

db.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    void showChat(session.user);
  } else {
    showLogin();
  }
});
