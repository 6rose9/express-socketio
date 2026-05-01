const socket = io(); // auto connect to the server that serves the page

socket.on("connect", () => {
  console.log("Socket connected with id ", socket.id);
});

// live
socket.on("post:created", (payload) => {
  console.log("Post created: ", payload);
  // option 1: show toast / alert
  //   showToast(`New post created: ${payload.title}`);
  showToastify({
    icon: "success",
    message: `New post created: ${payload.title}`,
  });

  // option 2: auto refresh the page
  setTimeout(() => {
    if (location.pathname === "/") location.reload();
  }, 1500);
});

socket.on("post:updated", (payload) => {
  console.log("Post updated: ", payload);

  // option 1: show toast / alert
  showToastify({
    icon: "info",
    message: `Post updated: ${payload.title}`,
  });

  // option 2: auto refresh the page
  setTimeout(() => {
    if (location.pathname === "/") location.reload();
  }, 1500);
});

socket.on("post:deleted", (payload) => {
  console.log("Post deleted: ", payload);

  // option 1: show toast / alert
  showToastify({
    icon: "error",
    message: `One post deleted!`,
  });

  // auto refresh the page
  setTimeout(() => {
    if (location.pathname === "/") location.reload();
  }, 1500);
});

// boostarp toast
function showToast(message) {
  const toastEl = document.getElementById("liveToast");
  const toastBodyEl = toastEl.querySelector(".toast-body");

  if (!toastEl || !toastBodyEl) return;
  toastBodyEl.textContent = message;

  const toast = new bootstrap.Toast(toastEl, {
    delay: 3000, // auto hide after 3 seconds
    autohide: true,
  });

  toast.show();
}

// toastify toast
function showToastify({ icon, message }) {
  switch (icon) {
    case "success":
      backgroundColor = "linear-gradient(to right, #00b09b, #96c93d)";
      break;
    case "error":
      backgroundColor = "linear-gradient(to right, #ff5f6d, #ffc371)";
      break;
    case "info":
      backgroundColor = "linear-gradient(to right, #2193b0, #6dd5ed)";
      break;
    case "warning":
      backgroundColor = "linear-gradient(to right, #ff9a9e, #fad0c4)";
      break;
    default:
      backgroundColor = "linear-gradient(to right, #00b09b, #96c93d)";
  }

  Toastify({
    icon, // "success", "error", "info", "warning"
    text: message,
    duration: 3000, // auto hide after 3 seconds
    close: true, // show close button
    gravity: "top", // top or bottom
    position: "right", // left, center or right
    backgroundColor,
  }).showToast();
}
