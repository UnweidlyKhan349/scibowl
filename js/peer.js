/* Thin wrapper around PeerJS for a star-topology multiplayer room.
   Host holds the authoritative game state; every client only ever
   talks to the host (no client-to-client connections). */
(function (global) {
  function randomRoomCode() {
    // short, easy to read/say aloud
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  function makeHost({ onPlayerMessage, onPlayerConnect, onPlayerDisconnect, onError }) {
    const roomCode = 'sbowl-' + randomRoomCode();
    const peer = new Peer(roomCode, { debug: 1 });
    const conns = new Map(); // connId -> DataConnection

    const api = {
      roomCode,
      peer,
      ready: new Promise((resolve, reject) => {
        peer.on('open', (id) => resolve(id));
        peer.on('error', (err) => { onError && onError(err); reject(err); });
      }),
      broadcast(data) {
        for (const c of conns.values()) {
          if (c.open) c.send(data);
        }
      },
      sendTo(connId, data) {
        const c = conns.get(connId);
        if (c && c.open) c.send(data);
      },
      playerCount() { return conns.size; },
      close() {
        for (const c of conns.values()) c.close();
        peer.destroy();
      },
    };

    peer.on('connection', (conn) => {
      conns.set(conn.peer, conn);
      conn.on('data', (data) => onPlayerMessage && onPlayerMessage(conn.peer, data));
      conn.on('open', () => onPlayerConnect && onPlayerConnect(conn.peer));
      conn.on('close', () => {
        conns.delete(conn.peer);
        onPlayerDisconnect && onPlayerDisconnect(conn.peer);
      });
      conn.on('error', () => {
        conns.delete(conn.peer);
        onPlayerDisconnect && onPlayerDisconnect(conn.peer);
      });
    });

    peer.on('error', (err) => onError && onError(err));

    return api;
  }

  function makeClient(roomCode, { onHostMessage, onDisconnect, onError }) {
    const peer = new Peer({ debug: 1 });
    let conn = null;

    const api = {
      peer,
      ready: new Promise((resolve, reject) => {
        peer.on('open', () => {
          conn = peer.connect(roomCode.trim(), { reliable: true });
          conn.on('open', () => resolve());
          conn.on('data', (data) => onHostMessage && onHostMessage(data));
          conn.on('close', () => onDisconnect && onDisconnect());
          conn.on('error', (err) => { onError && onError(err); reject(err); });
        });
        peer.on('error', (err) => { onError && onError(err); reject(err); });
      }),
      send(data) {
        if (conn && conn.open) conn.send(data);
      },
      close() {
        if (conn) conn.close();
        peer.destroy();
      },
    };
    return api;
  }

  global.SBPeer = { makeHost, makeClient };
})(window);
