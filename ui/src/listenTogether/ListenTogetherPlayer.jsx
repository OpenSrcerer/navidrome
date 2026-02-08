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
  const [position, setPosition] = useState(0)
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

    const ws = new ListenTogetherWebSocket(sessionId, displayName, false)
    wsRef.current = ws

    ws.onWelcome = (data) => {
      setMyId(data.yourId)
    }

    ws.onState = (state) => {
      setQueue(state.queue || [])
      setCurrentTrackIndex(state.currentTrackIndex || 0)
      setPosition(state.position || 0)
      setIsPlaying(state.isPlaying || false)
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

  // Audio playback sync
  useEffect(() => {
    if (!currentTrack || !connected) return

    const audio = audioRef.current
    if (!audio) return

    const streamUrl = `/share/lt/s/${currentTrack.token}`
    if (audio.src !== window.location.origin + streamUrl) {
      audio.src = streamUrl
    }

    if (isPlaying) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }

    // Sync position (allow 2 second drift)
    if (Math.abs(audio.currentTime - position) > 2) {
      audio.currentTime = position
    }
  }, [currentTrack, isPlaying, position, connected])

  // Send periodic sync if remote holder
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
          trackIndex: currentTrackIndex,
        })
      }
    }, 3000)

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current)
      }
    }
  }, [isRemoteHolder, connected, currentTrackIndex])

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
    ? (position / currentTrack.duration) * 100
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
                  <span>{formatTime(position)}</span>
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
