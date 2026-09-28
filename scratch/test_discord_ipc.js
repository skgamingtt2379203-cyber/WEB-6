const net = require('net');

function tryConnect(pipeIndex = 0) {
  if (pipeIndex > 9) {
    console.log('No Discord IPC pipe found');
    return;
  }
  const pipePath = `\\\\?\\pipe\\discord-ipc-${pipeIndex}`;
  const socket = net.connect(pipePath);

  socket.on('connect', () => {
    console.log(`Connected to ${pipePath}!`);

    // Handshake opcode 0
    // We can use a client ID. E.g. VS Code RPC ID or a general one or let's test:
    const clientId = '1344697306231935048'; // or '1100000000000000000' or Discord's sample IDs
    const handshake = JSON.stringify({ v: 1, client_id: clientId });
    const header = Buffer.alloc(8);
    header.writeInt32LE(0, 0); // Opcode 0 = Handshake
    header.writeInt32LE(Buffer.byteLength(handshake), 4);
    socket.write(Buffer.concat([header, Buffer.from(handshake)]));
  });

  socket.on('data', (data) => {
    const op = data.readInt32LE(0);
    const len = data.readInt32LE(4);
    const json = data.subarray(8, 8 + len).toString();
    console.log('Received op:', op, 'data:', json);
    socket.destroy();
  });

  socket.on('error', (err) => {
    socket.destroy();
    tryConnect(pipeIndex + 1);
  });
}

tryConnect(0);
