import { io } from 'socket.io-client';

const PORT = process.env.PORT || 8080;
const SERVER_URL = `http://localhost:${PORT}`;

// Connect to the control socket and ask the server to stop.
const socket = io(SERVER_URL, {
  reconnectionAttempts: 3,
  timeout: 2000,
});

socket.on('connect', () => {
  console.log('Connected to server control socket, sending npmStop...');
  socket.emit('npmStop');
  // Give the server a moment to shutdown gracefully, then exit this helper.
  setTimeout(() => {
    console.log('Stop signal sent, exiting stop script.');
    process.exit(0);
  }, 1000);
});

socket.on('connect_error', (err) => {
  console.error('Failed to connect to server control socket:', err.message || err);
  // Exit non-zero to indicate failure to stop via socket.
  process.exit(1);
});
