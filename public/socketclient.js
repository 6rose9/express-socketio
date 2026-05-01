const socket = io(); // auto connect to the server that serves the page

socket.on("connect", () => {
  console.log("Socket connected with id ", socket.id);
});

// live
socket.on("post:created", (payload) => {
    console.log("Post created: ", payload);
    // option 1: show toast / alert
    // option 2: auto refresh the page
    location.reload();
});

socket.on("post:updated", (payload) => {
    console.log("Post updated: ", payload);
    // option 1: show toast / alert
    // option 2: auto refresh the page
    if(location.pathname === "/") location.reload();
    
});

socket.on("post:deleted", (payload) => {
    console.log("Post deleted: ", payload);
    // option 1: show toast / alert
    // option 2: auto refresh the page
    if(location.pathname === "/") location.reload();
});
