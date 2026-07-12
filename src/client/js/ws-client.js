const RETRY_DELAY_MS = 3000;

// WebSocket with guarded auto-reconnect: at most one socket and one pending
// retry at any time, JSON messages parsed safely, and no reconnect (or
// spurious close/error callbacks) after an intentional close().
export class ReconnectingSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.retryTimer = null;
    this.closedByUser = true;

    // Assign these before connect(); all are optional.
    this.onOpen = () => {};
    this.onMessage = () => {}; // receives the parsed JSON object
    this.onClose = () => {}; // network drop, fired before scheduling a retry
    this.onError = () => {};
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // Safe to call repeatedly: no-ops while a socket is open or connecting,
  // and revives a dead one immediately (cancelling any pending retry).
  connect() {
    this.closedByUser = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    this.ws.onclose = () => {
      this.onClose();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, RETRY_DELAY_MS);
    };
    this.ws.onerror = () => this.onError();
  }

  // Intentional close: detaches handlers first so no retry is scheduled and
  // no close/error callback fires from our own action.
  close() {
    this.closedByUser = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      this.ws.close(1000, "User disconnected");
      this.ws = null;
    }
  }

  // Raw frame (e.g. binary PCM16). Dropped silently while disconnected.
  send(data) {
    if (this.isOpen) this.ws.send(data);
  }

  sendJson(obj) {
    this.send(JSON.stringify(obj));
  }
}
