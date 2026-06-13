import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
  IconButton,
  InputBase,
  LinearProgress,
  List,
  ListItem,
  ListItemAvatar,
  ListItemIcon,
  ListItemSecondaryAction,
  ListItemText,
  Paper,
  Slider,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@material-ui/core'
import { makeStyles } from '@material-ui/core/styles'
import {
  Delete as DeleteIcon,
  MusicNote as MusicNoteIcon,
  Pause as PauseIcon,
  Person as PersonIcon,
  PlayArrow as PlayIcon,
  Search as SearchIcon,
  SkipNext as SkipNextIcon,
  SkipPrevious as SkipPrevIcon,
  Star as StarIcon,
  Add as AddIcon,
  ExitToApp as LeaveIcon,
  SwapHoriz as SwapIcon,
  VolumeUp as VolumeUpIcon,
  VolumeOff as VolumeOffIcon,
  DragIndicator as DragIcon,
  Sync as SyncIcon,
  SyncDisabled as SyncDisabledIcon,
  HourglassEmpty as HourglassIcon,
  QueueMusic as QueueMusicIcon,
} from '@material-ui/icons'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { listenTogetherInfo } from '../config'
import ListenTogetherWebSocket from './ListenTogetherWebSocket'

const QUEUE_ITEM_TYPE = 'LT_QUEUE_ITEM'

// DraggableQueueItem wraps a queue row so the remote holder can drag it onto
// another row to reorder the queue. The reorder command is sent once, on drop,
// and the UI updates from the server broadcast (no optimistic local state).
const DraggableQueueItem = ({ index, canDrag, onDropItem, children }) => {
  const ref = useRef(null)
  const [{ isOver }, drop] = useDrop({
    accept: QUEUE_ITEM_TYPE,
    canDrop: () => canDrag,
    drop: (item) => {
      if (item.index !== index) onDropItem(item.index, index)
    },
    collect: (monitor) => ({ isOver: monitor.isOver() && canDrag }),
  })
  const [{ isDragging }, drag] = useDrag({
    type: QUEUE_ITEM_TYPE,
    item: { index },
    canDrag,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  })
  drag(drop(ref))
  return (
    <div
      ref={ref}
      style={{
        opacity: isDragging ? 0.4 : 1,
        borderTop: isOver ? '2px solid #1976d2' : '2px solid transparent',
      }}
    >
      {children}
    </div>
  )
}

const useStyles = makeStyles((theme) => ({
  root: {
    minHeight: '100vh',
    backgroundColor: theme.palette.type === 'dark' ? '#121212' : '#f5f5f5',
    display: 'flex',
    flexDirection: 'column',
  },
  appBar: {
    backgroundColor: theme.palette.primary.main,
  },
  title: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
    padding: theme.spacing(3),
    maxWidth: 1200,
    margin: '0 auto',
    width: '100%',
  },
  nowPlaying: {
    textAlign: 'center',
    padding: theme.spacing(3),
    marginBottom: theme.spacing(2),
  },
  albumArt: {
    width: 200,
    height: 200,
    margin: '0 auto',
    marginBottom: theme.spacing(2),
    backgroundColor: theme.palette.grey[300],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing(2),
    marginTop: theme.spacing(2),
    marginBottom: theme.spacing(1),
  },
  progressBar: {
    width: '100%',
    marginTop: theme.spacing(1),
  },
  progressText: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.75rem',
    color: theme.palette.text.secondary,
  },
  panel: {
    padding: theme.spacing(2),
    height: '100%',
  },
  queueItem: {
    '&.active': {
      backgroundColor: theme.palette.action.selected,
    },
  },
  searchBar: {
    padding: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    marginBottom: theme.spacing(1),
  },
  searchInput: {
    marginLeft: theme.spacing(1),
    flex: 1,
  },
  participantItem: {
    paddingRight: theme.spacing(8),
  },
  remoteChip: {
    marginLeft: theme.spacing(1),
  },
  disabledControl: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  nameDialog: {
    minWidth: 300,
  },
  searchResults: {
    maxHeight: 300,
    overflow: 'auto',
    marginBottom: theme.spacing(1),
  },
  reactionBar: {
    display: 'flex',
    justifyContent: 'center',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  },
  reactionButton: {
    fontSize: '1.4rem',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 4,
    borderRadius: 6,
    lineHeight: 1,
    '&:hover': { backgroundColor: theme.palette.action.hover },
  },
  '@keyframes ltFloatUp': {
    '0%': { transform: 'translateY(0) scale(1)', opacity: 1 },
    '100%': { transform: 'translateY(-140px) scale(1.4)', opacity: 0 },
  },
  floatingReaction: {
    position: 'absolute',
    bottom: 24,
    fontSize: '2rem',
    animation: '$ltFloatUp 3.5s ease-out forwards',
    pointerEvents: 'none',
    textAlign: 'center',
    width: 'auto',
  },
  chatPanel: {
    padding: theme.spacing(2),
    marginTop: theme.spacing(3),
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 300,
  },
  chatMessages: {
    flex: 1,
    overflowY: 'auto',
    marginBottom: theme.spacing(1),
  },
  chatLine: {
    marginBottom: theme.spacing(0.5),
    fontSize: '0.85rem',
    wordBreak: 'break-word',
  },
  chatInputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  },
  markerTrack: {
    position: 'absolute',
    top: -2,
    left: 0,
    right: 0,
    height: 0,
    pointerEvents: 'none',
  },
  posMarker: {
    position: 'absolute',
    transform: 'translateX(-50%)',
    width: 18,
    height: 18,
    borderRadius: '50%',
    color: '#fff',
    fontSize: '0.6rem',
    fontWeight: 'bold',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid #fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
    pointerEvents: 'auto',
  },
}))

const REACTION_EMOJIS = ['❤️', '🔥', '😂', '🎉', '👍', '😮']

// Drift-correction tuning (seconds). Below SOFT we leave playback alone; between
// SOFT and HARD we nudge playbackRate to converge smoothly; above HARD we hard-seek.
const SOFT_THRESHOLD = 0.12
const HARD_THRESHOLD = 1.0
// Window over which a soft correction aims to eliminate the drift.
const CORRECTION_WINDOW = 8
// Actions that always force an exact position (explicit playback changes), as
// opposed to "tick" updates which are only soft-corrected.
const HARD_ACTIONS = [
  'seek',
  'skip_next',
  'skip_prev',
  'welcome',
  'auto_advance',
  'play',
  'pause',
]

const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const ListenTogetherPlayer = () => {
  const classes = useStyles()
  const wsRef = useRef(null)
  const audioRef = useRef(null)
  const syncIntervalRef = useRef(null)
  const currentTrackIndexRef = useRef(0)
  // Estimated offset (ms) between the server clock and this client's clock,
  // serverTime ≈ Date.now() + clockOffsetRef.current. Smoothed across messages.
  const clockOffsetRef = useRef(null)
  // Position (seconds) to seek to once the next track's source finishes loading.
  const pendingSeekRef = useRef(null)
  // Mirror of derived state for use inside stable event/WS callbacks.
  const isRemoteHolderRef = useRef(false)
  const isPlayingRef = useRef(false)
  const followingRef = useRef(true)
  const effectivePlayingRef = useRef(false)
  // Latest known live (group) point, for "return to live".
  const liveRef = useRef({ position: 0, serverTime: 0, isPlaying: false })

  // A stable per-browser identity so reconnects keep remote-holder status.
  const clientIdRef = useRef(null)
  if (!clientIdRef.current) {
    let cid = localStorage.getItem('lt_client_id')
    if (!cid) {
      cid =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      localStorage.setItem('lt_client_id', cid)
    }
    clientIdRef.current = cid
  }

  // State
  const [myId, setMyId] = useState(null)
  const [connected, setConnected] = useState(false)
  const [displayName, setDisplayName] = useState(
    localStorage.getItem('lt_display_name') || '',
  )
  const [nameDialogOpen, setNameDialogOpen] = useState(true)
  const [nameInput, setNameInput] = useState(
    localStorage.getItem('lt_display_name') || '',
  )

  // Session state from server
  const [queue, setQueue] = useState([])
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0)
  const [localPosition, setLocalPosition] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [participants, setParticipants] = useState([])
  const [remoteHolder, setRemoteHolder] = useState({
    holderId: '',
    holderName: '',
  })

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)

  // Remote request state
  const [remoteRequest, setRemoteRequest] = useState(null)

  // Playback UX state
  const [volume, setVolume] = useState(() => {
    const v = parseFloat(localStorage.getItem('lt_volume'))
    return isNaN(v) ? 1 : v
  })
  const [buffering, setBuffering] = useState(false)
  const [bufferedFraction, setBufferedFraction] = useState(0)
  const [sessionEnded, setSessionEnded] = useState(false)
  // Whether this client is following the live/group position+playback. Becomes
  // false when the user scrubs or toggles play/pause locally.
  const [following, setFollowing] = useState(true)
  // Local play/pause state used while NOT following (independent playback).
  const [localPlaying, setLocalPlaying] = useState(false)
  // Everyone's spot on the track, for the timeline markers.
  const [participantPositions, setParticipantPositions] = useState([])

  // Chat + reactions
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [floatingReactions, setFloatingReactions] = useState([])
  const chatEndRef = useRef(null)
  const reactionSeqRef = useRef(0)

  const isRemoteHolder = myId && remoteHolder.holderId === myId
  const currentTrack = queue[currentTrackIndex]

  const sessionId = listenTogetherInfo?.id

  // The holder always reflects the group; non-holders reflect group only while
  // following, otherwise their own local play state.
  const detached = !isRemoteHolder && !following
  const effectivePlaying = detached ? localPlaying : isPlaying

  // serverNow() estimates the current server wall-clock from our local clock.
  const serverNow = () => Date.now() + (clockOffsetRef.current || 0)
  // The live (group) position right now, latency-compensated.
  const liveNow = () => {
    const l = liveRef.current
    let pos = l.position || 0
    if (l.isPlaying && l.serverTime > 0) {
      const elapsed = (serverNow() - l.serverTime) / 1000
      if (elapsed > 0) pos += elapsed
    }
    return pos
  }

  // Sync indicator shown in the app bar. It describes whether THIS listener is
  // playing along with whoever holds the remote. The remote holder is the source
  // of truth, so it has no sync state and the chip is hidden for them.
  const syncStatus = detached
    ? {
        label: 'Browsing on your own',
        color: '#6a1b9a',
        icon: <SyncDisabledIcon />,
        tooltip:
          'You scrubbed or paused on your own, so you are no longer in sync. Use "Return to live" to rejoin the group.',
      }
    : buffering
      ? {
          label: 'Buffering…',
          color: '#ed6c02',
          icon: <HourglassIcon />,
          tooltip: 'Loading audio…',
        }
      : {
          label: 'In sync',
          color: '#2e7d32',
          icon: <SyncIcon />,
          tooltip: 'You are listening in sync with the group.',
        }

  // Keep a ref in sync so stable callbacks (WS handlers, audio events) can read
  // the current remote-holder status without being re-created.
  useEffect(() => {
    isRemoteHolderRef.current = !!isRemoteHolder
    // The holder is the source of truth and must play at normal speed; clear any
    // leftover drift-correction nudge from when this client was a listener, and
    // re-attach to the live state (the holder cannot be "browsing").
    if (isRemoteHolder) {
      if (audioRef.current) audioRef.current.playbackRate = 1.0
      setFollowing(true)
    }
  }, [isRemoteHolder])

  useEffect(() => {
    followingRef.current = following
  }, [following])

  useEffect(() => {
    effectivePlayingRef.current = effectivePlaying
  }, [effectivePlaying])

  // Check if name was previously set
  useEffect(() => {
    const savedName = localStorage.getItem('lt_display_name')
    if (savedName) {
      setDisplayName(savedName)
      setNameDialogOpen(false)
    }
  }, [])

  // Connect WebSocket after name is set
  useEffect(() => {
    if (!displayName || !sessionId || nameDialogOpen) return

    const ws = new ListenTogetherWebSocket(
      sessionId,
      displayName,
      false,
      clientIdRef.current,
    )
    wsRef.current = ws

    // Apply a position update to the local audio element. Explicit actions and
    // large drift hard-seek; small drift (ticks) is corrected by nudging
    // playbackRate so it converges smoothly without an audible jump. The remote
    // holder is the source of truth and never soft-corrects itself.
    const applyPositionCorrection = (target, action, playing) => {
      const audio = audioRef.current
      if (!audio) return
      const drift = audio.currentTime - target // >0 means we are ahead
      const absDrift = Math.abs(drift)

      if (HARD_ACTIONS.includes(action) || absDrift > HARD_THRESHOLD) {
        if (absDrift > 0.05) {
          try {
            audio.currentTime = target
          } catch {
            /* seeking before metadata is ready — ignore */
          }
        }
        audio.playbackRate = 1.0
        setLocalPosition(target)
        return
      }

      if (!isRemoteHolderRef.current && playing && absDrift > SOFT_THRESHOLD) {
        const rate = 1 - drift / CORRECTION_WINDOW
        audio.playbackRate = Math.max(0.94, Math.min(1.06, rate))
      } else {
        audio.playbackRate = 1.0
      }
    }

    ws.onWelcome = (data) => {
      setMyId(data.yourId)
    }

    ws.onState = (state) => {
      setQueue(state.queue || [])
      const playing = state.isPlaying || false
      setIsPlaying(playing)
      isPlayingRef.current = playing

      // Update our estimate of the server clock (smoothed).
      if (typeof state.serverTime === 'number' && state.serverTime > 0) {
        const raw = state.serverTime - Date.now()
        clockOffsetRef.current =
          clockOffsetRef.current == null
            ? raw
            : clockOffsetRef.current * 0.8 + raw * 0.2
      }

      const newTrackIndex = state.currentTrackIndex || 0
      const prevTrackIndex = currentTrackIndexRef.current
      setCurrentTrackIndex(newTrackIndex)
      currentTrackIndexRef.current = newTrackIndex

      const action = state.action || ''

      // Latency-compensated target: the authoritative position was captured at
      // state.serverTime; if playing, add the time elapsed since then.
      let target = state.position || 0
      if (playing && typeof state.serverTime === 'number' && state.serverTime > 0) {
        const elapsed = (serverNow() - state.serverTime) / 1000
        if (elapsed > 0) target += elapsed
      }

      // Remember the live point for "return to live".
      liveRef.current = {
        position: state.position || 0,
        serverTime: state.serverTime || 0,
        isPlaying: playing,
      }

      const trackChanged = newTrackIndex !== prevTrackIndex
      if (trackChanged) {
        // A new track is global: everyone loads it and re-attaches to the group
        // at the start. The source effect loads it; the seek is applied on 'canplay'.
        pendingSeekRef.current = target
        setLocalPosition(target)
        setFollowing(true)
        followingRef.current = true
        return
      }

      // Queue-only updates (add/remove/reorder) must not disturb playback.
      if (action.startsWith('queue_')) return

      // The host's "move everyone here" overrides position for ALL clients
      // (including detached ones), but leaves play/pause and following untouched.
      if (action === 'sync_all') {
        const audio = audioRef.current
        if (audio) {
          try {
            audio.currentTime = target
          } catch {
            /* ignore */
          }
          audio.playbackRate = 1.0
        }
        setLocalPosition(target)
        return
      }

      // Detached clients ignore normal group position updates.
      if (!isRemoteHolderRef.current && !followingRef.current) return

      applyPositionCorrection(target, action, playing)
    }

    ws.onParticipants = (data) => {
      setParticipants(data.participants || [])
    }

    ws.onPositions = (data) => {
      setParticipantPositions(data.positions || [])
      if (typeof data.serverTime === 'number' && data.serverTime > 0) {
        liveRef.current = {
          position: data.live || 0,
          serverTime: data.serverTime,
          isPlaying: liveRef.current.isPlaying,
        }
      }
    }

    ws.onRemote = (data) => {
      setRemoteHolder(data)
    }

    ws.onRemoteRequested = (data) => {
      setRemoteRequest(data)
    }

    ws.onError = (data) => {
      if (data?.action === 'session_ended') {
        setConnected(false)
        setSessionEnded(true)
      }
    }

    ws.onConnectionChange = (isConnected) => {
      setConnected(isConnected)
    }

    ws.onChatHistory = (data) => {
      setChatMessages(data.messages || [])
    }

    ws.onChat = (data) => {
      setChatMessages((prev) => [...prev.slice(-99), data])
    }

    ws.onReaction = (data) => {
      const id = `${data.ts || Date.now()}-${reactionSeqRef.current++}`
      setFloatingReactions((prev) => [...prev, { ...data, id }])
      // Auto-remove the floating emoji after its animation.
      setTimeout(() => {
        setFloatingReactions((prev) => prev.filter((r) => r.id !== id))
      }, 3500)
    }

    ws.connect()

    return () => {
      ws.disconnect()
    }
  }, [displayName, sessionId, nameDialogOpen])

  // Track local playback position via the audio element's timeupdate event.
  // This gives smooth, continuous progress bar updates without relying on
  // periodic server broadcasts.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const handleTimeUpdate = () => {
      setLocalPosition(audio.currentTime)
    }
    audio.addEventListener('timeupdate', handleTimeUpdate)
    return () => audio.removeEventListener('timeupdate', handleTimeUpdate)
  }, [])

  // Apply the (persisted) volume to the audio element.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
    localStorage.setItem('lt_volume', String(volume))
  }, [volume])

  // Track buffering state and how much of the current track is buffered, for the
  // loading spinner and the buffered bar behind the scrubber. The "buffering"
  // flag is debounced so the brief stall on a normal track change/seek doesn't
  // flicker the indicator (which looked like a graphical glitch).
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    let bufferTimer = null
    const onWaiting = () => {
      if (bufferTimer) return
      bufferTimer = setTimeout(() => {
        bufferTimer = null
        setBuffering(true)
      }, 600)
    }
    const onPlaying = () => {
      if (bufferTimer) {
        clearTimeout(bufferTimer)
        bufferTimer = null
      }
      setBuffering(false)
    }
    const onCanPlay = onPlaying
    const updateBuffered = () => {
      try {
        if (audio.buffered.length && audio.duration) {
          setBufferedFraction(
            audio.buffered.end(audio.buffered.length - 1) / audio.duration,
          )
        }
      } catch {
        /* ignore */
      }
    }
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onWaiting)
    audio.addEventListener('seeking', onWaiting)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('seeked', onPlaying)
    audio.addEventListener('canplay', onCanPlay)
    audio.addEventListener('progress', updateBuffered)
    audio.addEventListener('timeupdate', updateBuffered)
    return () => {
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onWaiting)
      audio.removeEventListener('seeking', onWaiting)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('seeked', onPlaying)
      audio.removeEventListener('canplay', onCanPlay)
      audio.removeEventListener('progress', updateBuffered)
      audio.removeEventListener('timeupdate', updateBuffered)
      if (bufferTimer) clearTimeout(bufferTimer)
    }
  }, [])

  // Reset the buffered indicator when the track changes.
  useEffect(() => {
    setBufferedFraction(0)
  }, [currentTrack?.id])

  // Auto-scroll the chat to the newest message.
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages])

  // Load the audio source ONLY when the track itself changes (keyed on the
  // track id, not the array object), so unrelated state updates — queue edits,
  // ticks, participant changes — never reload or restart playback. A pending
  // seek (set on track change / late join) is applied once the new source is
  // buffered, then playback resumes if the session is playing.
  useEffect(() => {
    if (!currentTrack || !connected) return
    const audio = audioRef.current
    if (!audio) return

    const streamUrl = `/share/lt/s/${currentTrack.token}`
    const fullUrl = window.location.origin + streamUrl
    if (audio.src === fullUrl) return

    audio.src = streamUrl
    const onCanPlay = () => {
      if (pendingSeekRef.current != null) {
        try {
          audio.currentTime = pendingSeekRef.current
        } catch {
          /* ignore */
        }
        pendingSeekRef.current = null
      }
      if (effectivePlayingRef.current) {
        audio.play().catch(() => {})
      }
    }
    audio.addEventListener('canplay', onCanPlay, { once: true })
    return () => audio.removeEventListener('canplay', onCanPlay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, currentTrack?.token, connected])

  // Toggle play/pause on the already-loaded source. Uses the effective play
  // state: the group's while following, or this client's own while detached.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !connected || !currentTrack) return
    if (effectivePlaying) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePlaying, connected])

  // When the holder's track finishes, tell the server so it can advance the
  // queue. This is a fallback for the server's own advance timer (which handles
  // backgrounded tabs and is the primary mechanism); the server ignores it
  // unless we genuinely appear to be at the end, making the two idempotent.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onEnded = () => {
      if (isRemoteHolderRef.current && wsRef.current) {
        wsRef.current.sendCommand('track_ended')
      }
    }
    audio.addEventListener('ended', onEnded)
    return () => audio.removeEventListener('ended', onEnded)
  }, [])

  // Periodic position report (every client). The holder sends "sync", which
  // also drives the server's authoritative clock and the drift-correction ticks;
  // everyone else sends "report_position" with their own spot + follow state.
  // Both feed the shared timeline view.
  useEffect(() => {
    if (!connected) {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
      return
    }

    syncIntervalRef.current = setInterval(() => {
      const audio = audioRef.current
      if (!audio || !wsRef.current) return
      if (isRemoteHolderRef.current) {
        wsRef.current.sendCommand('sync', {
          position: audio.currentTime,
          trackIndex: currentTrackIndexRef.current,
        })
      } else {
        wsRef.current.sendCommand('report_position', {
          position: audio.currentTime,
          following: followingRef.current,
        })
      }
    }, 2000)

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
      }
    }
  }, [connected])

  // Name dialog
  const handleNameSubmit = () => {
    if (nameInput.trim()) {
      const name = nameInput.trim()
      localStorage.setItem('lt_display_name', name)
      setDisplayName(name)
      setNameDialogOpen(false)
    }
  }

  // Play/pause. The holder controls the group; anyone else controls their own
  // local playback and detaches from the live state when they do.
  const handlePlay = useCallback(() => {
    if (isRemoteHolder) {
      if (wsRef.current) wsRef.current.sendCommand('play')
    } else {
      setLocalPlaying(true)
      setFollowing(false)
    }
  }, [isRemoteHolder])

  const handlePause = useCallback(() => {
    if (isRemoteHolder) {
      if (wsRef.current) wsRef.current.sendCommand('pause')
    } else {
      setLocalPlaying(false)
      setFollowing(false)
    }
  }, [isRemoteHolder])

  // Skip navigates the shared queue — holder only.
  const handleSkipNext = useCallback(() => {
    if (isRemoteHolder && wsRef.current) {
      wsRef.current.sendCommand('skip_next')
    }
  }, [isRemoteHolder])

  const handleSkipPrev = useCallback(() => {
    if (isRemoteHolder && wsRef.current) {
      wsRef.current.sendCommand('skip_prev')
    }
  }, [isRemoteHolder])

  // Scrubbing. The holder moves the group (sends seek); anyone else moves only
  // their own playback and detaches.
  const handleSeek = useCallback(
    (newPosition) => {
      if (!currentTrack) return
      if (isRemoteHolder) {
        if (wsRef.current) wsRef.current.sendCommand('seek', { position: newPosition })
      } else {
        const audio = audioRef.current
        if (audio) {
          try {
            audio.currentTime = newPosition
          } catch {
            /* ignore */
          }
          audio.playbackRate = 1.0
        }
        setLocalPosition(newPosition)
        setFollowing(false)
      }
    },
    [isRemoteHolder, currentTrack],
  )

  // While dragging the scrubber, show the dragged position locally for instant
  // feedback; the actual seek is sent on release (onChangeCommitted).
  const handleScrubChange = useCallback((_e, value) => {
    setLocalPosition(value)
  }, [])

  // Re-sync this client fully to the live point: snap to the host's position and
  // adopt the host's play/pause state.
  const handleReturnToLive = useCallback(() => {
    const target = liveNow()
    const audio = audioRef.current
    if (audio) {
      try {
        audio.currentTime = target
      } catch {
        /* ignore */
      }
      audio.playbackRate = 1.0
    }
    setLocalPosition(target)
    setLocalPlaying(liveRef.current.isPlaying)
    setFollowing(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Host action: pull everyone's position to the current live point.
  const handleSyncEveryone = useCallback(() => {
    if (isRemoteHolder && wsRef.current) {
      wsRef.current.sendCommand('sync_all')
    }
  }, [isRemoteHolder])

  // Search
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !sessionId) return
    setSearching(true)
    try {
      const response = await fetch(
        `/share/lt/${sessionId}/search?q=${encodeURIComponent(searchQuery)}`,
      )
      if (response.ok) {
        const data = await response.json()
        setSearchResults(data)
      }
    } catch (err) {
      console.error('Search failed:', err)
    } finally {
      setSearching(false)
    }
  }, [searchQuery, sessionId])

  const handleAddToQueue = useCallback(
    (mediaFileId) => {
      if (wsRef.current && isRemoteHolder) {
        wsRef.current.sendCommand('queue_add', { mediaFileId })
        setSearchResults((prev) =>
          prev.filter((r) => r.id !== mediaFileId),
        )
      }
    },
    [isRemoteHolder],
  )

  const handleRemoveFromQueue = useCallback(
    (queuePosition) => {
      if (wsRef.current && isRemoteHolder) {
        wsRef.current.sendCommand('queue_remove', { queuePosition })
      }
    },
    [isRemoteHolder],
  )

  // Add tracks similar to a given track (instant-mix) to the queue. Holder only.
  const handleAddSimilar = useCallback(
    (mediaFileId) => {
      if (wsRef.current && isRemoteHolder && mediaFileId) {
        wsRef.current.sendCommand('queue_similar', { mediaFileId })
      }
    },
    [isRemoteHolder],
  )

  const handleReorder = useCallback(
    (from, to) => {
      if (wsRef.current && isRemoteHolder && from !== to) {
        wsRef.current.sendCommand('queue_reorder', { from, to })
      }
    },
    [isRemoteHolder],
  )

  const handleSendChat = useCallback(() => {
    const text = chatInput.trim()
    if (text && wsRef.current) {
      wsRef.current.sendCommand('chat', { text })
      setChatInput('')
    }
  }, [chatInput])

  const handleSendReaction = useCallback((emoji) => {
    if (wsRef.current) {
      wsRef.current.sendCommand('reaction', { emoji })
    }
  }, [])

  // Remote control
  const handleRequestRemote = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.sendCommand('request_remote')
    }
  }, [])

  const handlePassRemote = useCallback(
    (participantId) => {
      if (wsRef.current && isRemoteHolder) {
        wsRef.current.sendCommand('pass_remote', { participantId })
      }
    },
    [isRemoteHolder],
  )

  const handleAcceptRemoteRequest = useCallback(() => {
    if (wsRef.current && remoteRequest) {
      wsRef.current.sendCommand('accept_remote_request', {
        participantId: remoteRequest.fromId,
      })
      setRemoteRequest(null)
    }
  }, [remoteRequest])

  const handleDenyRemoteRequest = useCallback(() => {
    setRemoteRequest(null)
  }, [])

  const handleEndSession = useCallback(() => {
    if (wsRef.current && isRemoteHolder) {
      wsRef.current.sendCommand('end_session')
    }
  }, [isRemoteHolder])

  const handleLeave = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.disconnect()
    }
    window.close()
  }, [])

  return (
    <DndProvider backend={HTML5Backend}>
    <div className={classes.root}>
      {/* Hidden audio element for playback */}
      <audio ref={audioRef} />

      {/* Session Ended Dialog */}
      <Dialog open={sessionEnded} disableBackdropClick>
        <DialogTitle>Session Ended</DialogTitle>
        <DialogContent>
          <Typography>This Listen Together session has ended.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleLeave} color="primary">
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Name Entry Dialog */}
      <Dialog open={nameDialogOpen} disableBackdropClick disableEscapeKeyDown>
        <DialogTitle>Join Listen Together</DialogTitle>
        <DialogContent className={classes.nameDialog}>
          <TextField
            autoFocus
            margin="dense"
            label="Your Display Name"
            fullWidth
            variant="outlined"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleNameSubmit()}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={handleNameSubmit}
            color="primary"
            disabled={!nameInput.trim()}
          >
            Join
          </Button>
        </DialogActions>
      </Dialog>

      {/* Remote Request Dialog */}
      <Dialog open={!!remoteRequest} onClose={handleDenyRemoteRequest}>
        <DialogTitle>Remote Request</DialogTitle>
        <DialogContent>
          <Typography>
            <strong>{remoteRequest?.fromName}</strong> is requesting the remote
            control.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDenyRemoteRequest} color="default">
            Deny
          </Button>
          <Button onClick={handleAcceptRemoteRequest} color="primary">
            Accept
          </Button>
        </DialogActions>
      </Dialog>

      {/* App Bar */}
      <AppBar position="static" className={classes.appBar}>
        <Toolbar>
          <Typography variant="h6" className={classes.title}>
            {listenTogetherInfo?.description || 'Listen Together'}
          </Typography>
          <Chip
            icon={<PersonIcon />}
            label={`${participants.length} listener${participants.length !== 1 ? 's' : ''}`}
            color="default"
            variant="outlined"
            style={{ color: 'white', borderColor: 'rgba(255,255,255,0.5)' }}
          />
          {/* Sync chip: only for listeners. The remote holder is the source of
              truth and has no sync state, so no chip is shown for them. */}
          {!connected ? (
            <Chip
              label="Reconnecting..."
              color="secondary"
              size="small"
              style={{ marginLeft: 8 }}
            />
          ) : (
            !isRemoteHolder && (
              <Tooltip title={syncStatus.tooltip}>
                <Chip
                  icon={React.cloneElement(syncStatus.icon, {
                    style: { color: 'white' },
                    fontSize: 'small',
                  })}
                  label={syncStatus.label}
                  size="small"
                  style={{
                    marginLeft: 8,
                    color: 'white',
                    backgroundColor: syncStatus.color,
                  }}
                />
              </Tooltip>
            )
          )}
          <Tooltip title="Change display name">
            <IconButton
              color="inherit"
              onClick={() => {
                setNameInput(displayName)
                setNameDialogOpen(true)
              }}
            >
              <PersonIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Leave Session">
            <IconButton color="inherit" onClick={handleLeave}>
              <LeaveIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      {/* Main Content */}
      <Container className={classes.content}>
        <Grid container spacing={3}>
          {/* Now Playing + Controls */}
          <Grid item xs={12} md={4}>
            <Paper
              className={classes.nowPlaying}
              elevation={2}
              style={{ position: 'relative', overflow: 'hidden', height: '100%' }}
            >
              {/* Floating emoji reactions */}
              {floatingReactions.map((r, i) => (
                <span
                  key={r.id}
                  className={classes.floatingReaction}
                  style={{ left: `${15 + ((i * 17) % 70)}%` }}
                  title={r.senderName}
                >
                  {r.emoji}
                </span>
              ))}
              <div className={classes.albumArt} style={{ position: 'relative' }}>
                {currentTrack?.coverArt ? (
                  <img
                    src={currentTrack.coverArt}
                    alt={currentTrack.album || currentTrack.title}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 8,
                    }}
                    onError={(e) => {
                      e.target.style.display = 'none'
                    }}
                  />
                ) : (
                  <MusicNoteIcon style={{ fontSize: 80, color: '#999' }} />
                )}
                {buffering && isPlaying && (
                  <Box
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(0,0,0,0.35)',
                      borderRadius: 8,
                    }}
                  >
                    <CircularProgress style={{ color: '#fff' }} />
                  </Box>
                )}
              </div>
              {currentTrack ? (
                <>
                  <Typography variant="h5" gutterBottom>
                    {currentTrack.title}
                  </Typography>
                  <Typography variant="subtitle1" color="textSecondary">
                    {currentTrack.artist}
                  </Typography>
                  <Typography variant="body2" color="textSecondary">
                    {currentTrack.album}
                  </Typography>
                </>
              ) : (
                <Typography variant="h6" color="textSecondary">
                  No track playing
                </Typography>
              )}

              {/* Progress Bar — draggable scrubber (everyone can scrub their own
                  playback; the holder moves the group). Buffered amount sits
                  behind it; participant markers + the live point sit above. */}
              <Box className={classes.progressBar} style={{ position: 'relative' }}>
                <LinearProgress
                  variant="determinate"
                  value={Math.min(bufferedFraction * 100, 100)}
                  style={{
                    position: 'absolute',
                    top: 12,
                    left: 0,
                    right: 0,
                    opacity: 0.3,
                  }}
                />
                <Slider
                  value={Math.min(localPosition, currentTrack?.duration || 0)}
                  min={0}
                  max={currentTrack?.duration || 0}
                  step={0.1}
                  disabled={!currentTrack}
                  onChange={handleScrubChange}
                  onChangeCommitted={(_e, value) => handleSeek(value)}
                  aria-label="Seek"
                />
                {/* Position markers: where each participant is on the track */}
                {currentTrack?.duration > 0 && (
                  <div className={classes.markerTrack}>
                    {participantPositions
                      .filter((p) => p.id !== myId)
                      .map((p) => (
                        <Tooltip
                          key={p.id}
                          title={`${p.name}${p.following ? '' : ' (browsing)'} — ${formatTime(p.position)}`}
                        >
                          <div
                            className={classes.posMarker}
                            style={{
                              left: `${Math.min((p.position / currentTrack.duration) * 100, 100)}%`,
                              backgroundColor: p.following ? '#1976d2' : '#6a1b9a',
                            }}
                          >
                            {(p.name || '?').charAt(0).toUpperCase()}
                          </div>
                        </Tooltip>
                      ))}
                  </div>
                )}
                <div className={classes.progressText}>
                  <span>{formatTime(localPosition)}</span>
                  <span>{formatTime(currentTrack?.duration)}</span>
                </div>
              </Box>

              {/* Detached / sync controls */}
              {detached && (
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  onClick={handleReturnToLive}
                  style={{ marginBottom: 8 }}
                >
                  Return to live
                </Button>
              )}
              {isRemoteHolder && participants.length > 1 && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleSyncEveryone}
                  style={{ marginBottom: 8 }}
                >
                  Sync everyone to here
                </Button>
              )}

              {/* Playback Controls */}
              <div className={classes.controls}>
                <Tooltip
                  title={
                    isRemoteHolder ? 'Previous' : 'Only remote holder can control'
                  }
                >
                  <span>
                    <IconButton
                      onClick={handleSkipPrev}
                      disabled={!isRemoteHolder}
                    >
                      <SkipPrevIcon />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={
                    isRemoteHolder
                      ? effectivePlaying
                        ? 'Pause'
                        : 'Play'
                      : effectivePlaying
                        ? 'Pause (just you)'
                        : 'Play (just you)'
                  }
                >
                  <span>
                    <IconButton
                      onClick={effectivePlaying ? handlePause : handlePlay}
                      disabled={!currentTrack}
                      color="primary"
                      size="medium"
                    >
                      {effectivePlaying ? (
                        <PauseIcon fontSize="large" />
                      ) : (
                        <PlayIcon fontSize="large" />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={
                    isRemoteHolder ? 'Next' : 'Only remote holder can control'
                  }
                >
                  <span>
                    <IconButton
                      onClick={handleSkipNext}
                      disabled={!isRemoteHolder}
                    >
                      <SkipNextIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              </div>

              {/* Volume — local to each listener, persisted across sessions. */}
              <Box
                display="flex"
                alignItems="center"
                style={{ maxWidth: 220, margin: '0 auto', gap: 8 }}
              >
                <IconButton
                  size="small"
                  onClick={() => setVolume((v) => (v > 0 ? 0 : 1))}
                >
                  {volume > 0 ? (
                    <VolumeUpIcon fontSize="small" />
                  ) : (
                    <VolumeOffIcon fontSize="small" />
                  )}
                </IconButton>
                <Slider
                  value={volume}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={(_e, value) => setVolume(value)}
                  aria-label="Volume"
                />
              </Box>

              {!isRemoteHolder && (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleRequestRemote}
                  startIcon={<SwapIcon />}
                  style={{ marginTop: 8 }}
                >
                  Request Remote
                </Button>
              )}
              {isRemoteHolder && (
                <>
                  <Typography
                    variant="caption"
                    color="primary"
                    style={{ marginTop: 8, display: 'block' }}
                  >
                    You have the remote
                  </Typography>
                  <Tooltip title="Add tracks similar to this one (instant mix)">
                    <span>
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<QueueMusicIcon />}
                        onClick={() =>
                          handleAddSimilar(currentTrack?.mediaFileId)
                        }
                        disabled={!currentTrack}
                        style={{ marginTop: 8 }}
                      >
                        Add similar to queue
                      </Button>
                    </span>
                  </Tooltip>
                </>
              )}

              {/* Reaction bar — anyone can react */}
              <div className={classes.reactionBar}>
                {REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={classes.reactionButton}
                    onClick={() => handleSendReaction(emoji)}
                    aria-label={`React ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </Paper>
          </Grid>

          {/* Queue Panel */}
          <Grid item xs={12} md={4}>
            <Paper className={classes.panel} elevation={2}>
              <Typography variant="h6" gutterBottom>
                Queue
              </Typography>

              {/* Search bar (only for remote holder) */}
              {isRemoteHolder && (
                <>
                  <Paper className={classes.searchBar} variant="outlined">
                    <InputBase
                      className={classes.searchInput}
                      placeholder="Search library..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                    />
                    <IconButton onClick={handleSearch} size="small">
                      <SearchIcon />
                    </IconButton>
                  </Paper>

                  {/* Search Results */}
                  {searching && (
                    <Box display="flex" justifyContent="center" p={1}>
                      <CircularProgress size={24} />
                    </Box>
                  )}
                  {searchResults.length > 0 && (
                    <Paper
                      className={classes.searchResults}
                      variant="outlined"
                    >
                      <List dense>
                        {searchResults.map((result) => (
                          <ListItem key={result.id}>
                            <ListItemIcon>
                              <MusicNoteIcon fontSize="small" />
                            </ListItemIcon>
                            <ListItemText
                              primary={result.title}
                              secondary={`${result.artist} - ${result.album}`}
                            />
                            <ListItemSecondaryAction>
                              <IconButton
                                edge="end"
                                size="small"
                                onClick={() => handleAddToQueue(result.id)}
                              >
                                <AddIcon />
                              </IconButton>
                            </ListItemSecondaryAction>
                          </ListItem>
                        ))}
                      </List>
                    </Paper>
                  )}
                </>
              )}

              <Divider style={{ margin: '8px 0' }} />

              {isRemoteHolder && queue.length > 1 && (
                <Typography variant="caption" color="textSecondary">
                  Drag tracks to reorder
                </Typography>
              )}

              {/* Queue List */}
              <List dense>
                {queue.map((track, index) => (
                  <DraggableQueueItem
                    key={`${track.id}-${index}`}
                    index={index}
                    canDrag={isRemoteHolder && index !== currentTrackIndex}
                    onDropItem={handleReorder}
                  >
                    <ListItem
                      className={`${classes.queueItem} ${index === currentTrackIndex ? 'active' : ''}`}
                    >
                      <ListItemIcon>
                        {index === currentTrackIndex ? (
                          <PlayIcon color="primary" fontSize="small" />
                        ) : isRemoteHolder ? (
                          <DragIcon
                            fontSize="small"
                            style={{ color: '#999', cursor: 'grab' }}
                          />
                        ) : (
                          <Typography
                            variant="body2"
                            color="textSecondary"
                            style={{ width: 24, textAlign: 'center' }}
                          >
                            {index + 1}
                          </Typography>
                        )}
                      </ListItemIcon>
                      <ListItemText
                        primary={track.title}
                        secondary={track.artist}
                        primaryTypographyProps={{
                          noWrap: true,
                          style: {
                            fontWeight:
                              index === currentTrackIndex ? 'bold' : 'normal',
                          },
                        }}
                      />
                      {isRemoteHolder && index !== currentTrackIndex && (
                        <ListItemSecondaryAction>
                          <IconButton
                            edge="end"
                            size="small"
                            onClick={() => handleRemoveFromQueue(index)}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </ListItemSecondaryAction>
                      )}
                    </ListItem>
                  </DraggableQueueItem>
                ))}
                {queue.length === 0 && (
                  <ListItem>
                    <ListItemText
                      primary="Queue is empty"
                      primaryTypographyProps={{ color: 'textSecondary' }}
                    />
                  </ListItem>
                )}
              </List>
            </Paper>
          </Grid>

          {/* Participants + Chat (right column, chat fills remaining height) */}
          <Grid
            item
            xs={12}
            md={4}
            style={{ display: 'flex', flexDirection: 'column' }}
          >
            <Paper
              className={classes.panel}
              elevation={2}
              style={{ height: 'auto' }}
            >
              <Typography variant="h6" gutterBottom>
                Participants
              </Typography>
              <List dense>
                {participants.map((p) => (
                  <ListItem key={p.id} className={classes.participantItem}>
                    <ListItemAvatar>
                      <Avatar>
                        {p.isHost ? (
                          <StarIcon />
                        ) : (
                          <PersonIcon />
                        )}
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText
                      primary={
                        <span>
                          {p.name}
                          {p.id === myId && ' (you)'}
                          {remoteHolder.holderId === p.id && (
                            <Chip
                              label="Remote"
                              size="small"
                              color="primary"
                              className={classes.remoteChip}
                            />
                          )}
                        </span>
                      }
                    />
                    {isRemoteHolder && p.id !== myId && (
                      <ListItemSecondaryAction>
                        <Tooltip title="Pass remote">
                          <IconButton
                            edge="end"
                            size="small"
                            onClick={() => handlePassRemote(p.id)}
                          >
                            <SwapIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </ListItemSecondaryAction>
                    )}
                  </ListItem>
                ))}
              </List>

              {isRemoteHolder && (
                <>
                  <Divider style={{ margin: '16px 0' }} />
                  <Button
                    variant="outlined"
                    color="secondary"
                    fullWidth
                    onClick={handleEndSession}
                  >
                    End Session
                  </Button>
                </>
              )}
            </Paper>

            {/* Chat Panel */}
            <Paper className={classes.chatPanel} elevation={2}>
              <Typography variant="h6" gutterBottom>
                Chat
              </Typography>
              <div className={classes.chatMessages}>
                {chatMessages.length === 0 && (
                  <Typography variant="body2" color="textSecondary">
                    No messages yet. Say hi!
                  </Typography>
                )}
                {chatMessages.map((m) => (
                  <div key={m.id} className={classes.chatLine}>
                    <strong
                      style={{
                        color: m.senderId === myId ? '#1976d2' : undefined,
                      }}
                    >
                      {m.senderName}
                      {m.senderId === myId && ' (you)'}:
                    </strong>{' '}
                    <span>{m.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <div className={classes.chatInputRow}>
                <InputBase
                  fullWidth
                  placeholder="Type a message..."
                  value={chatInput}
                  inputProps={{ maxLength: 500 }}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendChat()}
                  style={{
                    border: '1px solid rgba(0,0,0,0.23)',
                    borderRadius: 4,
                    padding: '2px 8px',
                  }}
                />
                <Button
                  color="primary"
                  variant="contained"
                  size="small"
                  onClick={handleSendChat}
                  disabled={!chatInput.trim()}
                >
                  Send
                </Button>
              </div>
            </Paper>
          </Grid>
        </Grid>
      </Container>
    </div>
    </DndProvider>
  )
}

export default ListenTogetherPlayer
