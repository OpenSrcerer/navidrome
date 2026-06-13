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
} from '@material-ui/icons'
import { listenTogetherInfo } from '../config'
import ListenTogetherWebSocket from './ListenTogetherWebSocket'

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
}))

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

  const isRemoteHolder = myId && remoteHolder.holderId === myId
  const currentTrack = queue[currentTrackIndex]

  const sessionId = listenTogetherInfo?.id

  // Keep a ref in sync so stable callbacks (WS handlers, audio events) can read
  // the current remote-holder status without being re-created.
  useEffect(() => {
    isRemoteHolderRef.current = !!isRemoteHolder
    // The holder is the source of truth and must play at normal speed; clear any
    // leftover drift-correction nudge from when this client was a listener.
    if (isRemoteHolder && audioRef.current) {
      audioRef.current.playbackRate = 1.0
    }
  }, [isRemoteHolder])

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

    // serverNow() estimates the current server wall-clock from our local clock.
    const serverNow = () => Date.now() + (clockOffsetRef.current || 0)

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

      const trackChanged = newTrackIndex !== prevTrackIndex
      if (trackChanged) {
        // The source effect will load the new track; defer the seek until the
        // audio is ready (handled on the 'canplay' event).
        pendingSeekRef.current = target
        setLocalPosition(target)
        return
      }

      // Queue-only updates (add/remove/reorder) must not disturb playback.
      if (action.startsWith('queue_')) return

      applyPositionCorrection(target, action, playing)
    }

    ws.onParticipants = (data) => {
      setParticipants(data.participants || [])
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
        alert('The session has ended.')
      }
    }

    ws.onConnectionChange = (isConnected) => {
      setConnected(isConnected)
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
      if (isPlayingRef.current) {
        audio.play().catch(() => {})
      }
    }
    audio.addEventListener('canplay', onCanPlay, { once: true })
    return () => audio.removeEventListener('canplay', onCanPlay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, currentTrack?.token, connected])

  // Toggle play/pause on the already-loaded source when the session's playing
  // state changes. Track loading + initial play is handled by the effect above.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !connected || !currentTrack) return
    if (isPlaying) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, connected])

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

  // Send periodic sync if remote holder. This refreshes the server's
  // authoritative clock and drives drift correction for the other listeners.
  useEffect(() => {
    if (!isRemoteHolder || !connected) {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
        syncIntervalRef.current = null
      }
      return
    }

    syncIntervalRef.current = setInterval(() => {
      const audio = audioRef.current
      if (audio && wsRef.current) {
        wsRef.current.sendCommand('sync', {
          position: audio.currentTime,
          trackIndex: currentTrackIndexRef.current,
        })
      }
    }, 2000)

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
      }
    }
  }, [isRemoteHolder, connected])

  // Name dialog
  const handleNameSubmit = () => {
    if (nameInput.trim()) {
      const name = nameInput.trim()
      localStorage.setItem('lt_display_name', name)
      setDisplayName(name)
      setNameDialogOpen(false)
    }
  }

  // Playback controls (only for remote holder)
  const handlePlay = useCallback(() => {
    if (isRemoteHolder && wsRef.current) {
      wsRef.current.sendCommand('play')
    }
  }, [isRemoteHolder])

  const handlePause = useCallback(() => {
    if (isRemoteHolder && wsRef.current) {
      wsRef.current.sendCommand('pause')
    }
  }, [isRemoteHolder])

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

  const handleSeek = useCallback(
    (e) => {
      if (!isRemoteHolder || !currentTrack) return
      const bar = e.currentTarget
      const rect = bar.getBoundingClientRect()
      const ratio = (e.clientX - rect.left) / rect.width
      const newPosition = ratio * currentTrack.duration
      if (wsRef.current) {
        wsRef.current.sendCommand('seek', { position: newPosition })
      }
    },
    [isRemoteHolder, currentTrack],
  )

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

  const progressPercent = currentTrack
    ? (localPosition / currentTrack.duration) * 100
    : 0

  return (
    <div className={classes.root}>
      {/* Hidden audio element for playback */}
      <audio ref={audioRef} />

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
          {!connected && (
            <Chip
              label="Reconnecting..."
              color="secondary"
              size="small"
              style={{ marginLeft: 8 }}
            />
          )}
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
          <Grid item xs={12} md={5}>
            <Paper className={classes.nowPlaying} elevation={2}>
              <div className={classes.albumArt}>
                <MusicNoteIcon style={{ fontSize: 80, color: '#999' }} />
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

              {/* Progress Bar */}
              <Box
                className={classes.progressBar}
                onClick={isRemoteHolder ? handleSeek : undefined}
                style={{ cursor: isRemoteHolder ? 'pointer' : 'default' }}
              >
                <LinearProgress
                  variant="determinate"
                  value={Math.min(progressPercent, 100)}
                />
                <div className={classes.progressText}>
                  <span>{formatTime(localPosition)}</span>
                  <span>{formatTime(currentTrack?.duration)}</span>
                </div>
              </Box>

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
                      ? isPlaying
                        ? 'Pause'
                        : 'Play'
                      : 'Only remote holder can control'
                  }
                >
                  <span>
                    <IconButton
                      onClick={isPlaying ? handlePause : handlePlay}
                      disabled={!isRemoteHolder}
                      color="primary"
                      size="medium"
                    >
                      {isPlaying ? (
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
                <Typography
                  variant="caption"
                  color="primary"
                  style={{ marginTop: 8, display: 'block' }}
                >
                  You have the remote
                </Typography>
              )}
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

              {/* Queue List */}
              <List dense>
                {queue.map((track, index) => (
                  <ListItem
                    key={`${track.id}-${index}`}
                    className={`${classes.queueItem} ${index === currentTrackIndex ? 'active' : ''}`}
                  >
                    <ListItemIcon>
                      {index === currentTrackIndex ? (
                        <PlayIcon color="primary" fontSize="small" />
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

          {/* Participants Panel */}
          <Grid item xs={12} md={3}>
            <Paper className={classes.panel} elevation={2}>
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
                      secondary={p.isHost ? 'Host' : 'Guest'}
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
          </Grid>
        </Grid>
      </Container>
    </div>
  )
}

export default ListenTogetherPlayer
