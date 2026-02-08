/**
 * ListenTogetherWebSocket manages the WebSocket connection for a Listen Together session.
 *
 * Usage:
 *   const ws = new ListenTogetherWebSocket(sessionId, displayName, isHost)
 *   ws.onState = (state) => { ... }
 *   ws.onParticipants = (participants) => { ... }
 *   ws.onRemote = (remote) => { ... }
 *   ws.onRemoteRequested = (request) => { ... }
 *   ws.onWelcome = (data) => { ... }
 *   ws.onError = (error) => { ... }
 *   ws.onConnectionChange = (connected) => { ... }
 *   ws.connect()
 *
 *   ws.sendCommand('play')
 *   ws.sendCommand('seek', { position: 30.5 })
 *   ws.disconnect()
 */

const MAX_RECONNECT_DELAY = 30000
const INITIAL_RECONNECT_DELAY = 1000

class ListenTogetherWebSocket {
  constructor(sessionId, displayName, isHost = false) {
    this.sessionId = sessionId
    this.displayName = displayName
    this.isHost = isHost
    this.ws = null
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.connected = false
    this.intentionalClose = false

    // Callbacks
    this.onState = null
    this.onParticipants = null
    this.onRemote = null
    this.onRemoteRequested = null
    this.onWelcome = null
    this.onError = null
    this.onConnectionChange = null
  }

  connect() {
    this.intentionalClose = false
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const params = new URLSearchParams({
      name: this.displayName,
      host: this.isHost ? 'true' : 'false',
    })
    const url = `${protocol}//${host}/share/lt/${this.sessionId}/ws?${params}`

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      this._scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.connected = true
      this.reconnectAttempts = 0
      if (this.onConnectionChange) {
        this.onConnectionChange(true)
      }
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        this._handleMessage(msg)
      } catch (err) {
        console.error('ListenTogether WS: failed to parse message', err)
      }
    }

    this.ws.onclose = () => {
      this.connected = false
      if (this.onConnectionChange) {
        this.onConnectionChange(false)
      }
      if (!this.intentionalClose) {
        this._scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after this
    }
  }

  disconnect() {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
  }

  sendCommand(action, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }
    const msg = {
      type: 'command',
      action,
      ...(payload !== undefined && {
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }),
    }
    // The payload should be sent as json.RawMessage, so we serialize the whole thing
    const fullMsg = {
      type: 'command',
      action,
    }
    if (payload !== undefined) {
      fullMsg.payload = payload
    }
    this.ws.send(JSON.stringify(fullMsg))
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        if (this.onWelcome) {
          const data =
            typeof msg.payload === 'string'
              ? JSON.parse(msg.payload)
              : msg.payload
          this.onWelcome(data)
        }
        break
      case 'state':
        if (this.onState) {
          const data =
            typeof msg.payload === 'string'
              ? JSON.parse(msg.payload)
              : msg.payload
          this.onState(data)
        }
        break
      case 'participants':
        if (this.onParticipants) {
          const data =
            typeof msg.payload === 'string'
              ? JSON.parse(msg.payload)
              : msg.payload
          this.onParticipants(data)
        }
        break
      case 'remote':
        if (this.onRemote) {
          const data =
            typeof msg.payload === 'string'
              ? JSON.parse(msg.payload)
              : msg.payload
          this.onRemote(data)
        }
        break
      case 'remote_requested':
        if (this.onRemoteRequested) {
          const data =
            typeof msg.payload === 'string'
              ? JSON.parse(msg.payload)
              : msg.payload
          this.onRemoteRequested(data)
        }
        break
      case 'error':
        if (this.onError) {
          const data =
            typeof msg.payload === 'string'
              ? JSON.parse(msg.payload)
              : msg.payload
          this.onError(data)
        }
        break
      default:
        console.warn('ListenTogether WS: unknown message type', msg.type)
    }
  }

  _scheduleReconnect() {
    if (this.intentionalClose) return

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    )
    this.reconnectAttempts++

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }
}

export default ListenTogetherWebSocket
