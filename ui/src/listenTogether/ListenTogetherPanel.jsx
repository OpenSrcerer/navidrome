import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from '@material-ui/core'
import { makeStyles } from '@material-ui/core/styles'
import {
  Close as CloseIcon,
  ExpandLess,
  ExpandMore,
  Headset as HeadsetIcon,
  OpenInNew as OpenInNewIcon,
  Person as PersonIcon,
  Stop as StopIcon,
} from '@material-ui/icons'
import ListenTogetherWebSocket from './ListenTogetherWebSocket'

const useStyles = makeStyles((theme) => ({
  root: {
    position: 'fixed',
    bottom: 80,
    right: 16,
    zIndex: 1300,
    width: 300,
    borderRadius: 8,
    overflow: 'hidden',
    boxShadow: theme.shadows[8],
  },
  header: {
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
    padding: theme.spacing(1, 2),
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
  },
  headerIcon: {
    marginRight: theme.spacing(1),
  },
  headerTitle: {
    flexGrow: 1,
    fontSize: '0.875rem',
    fontWeight: 600,
  },
  content: {
    padding: theme.spacing(1.5),
    backgroundColor: theme.palette.background.paper,
  },
  participant: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    marginBottom: theme.spacing(0.5),
  },
  actions: {
    display: 'flex',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  },
}))

const ListenTogetherPanel = ({ sessionId, sessionUrl }) => {
  const classes = useStyles()
  const wsRef = useRef(null)
  const [expanded, setExpanded] = useState(true)
  const [connected, setConnected] = useState(false)
  const [participants, setParticipants] = useState([])
  const [remoteHolder, setRemoteHolder] = useState({})
  const [myId, setMyId] = useState(null)

  useEffect(() => {
    if (!sessionId) return

    const ws = new ListenTogetherWebSocket(sessionId, 'Host', true)
    wsRef.current = ws

    ws.onWelcome = (data) => setMyId(data.yourId)
    ws.onParticipants = (data) => setParticipants(data.participants || [])
    ws.onRemote = (data) => setRemoteHolder(data)
    ws.onConnectionChange = (isConnected) => setConnected(isConnected)
    ws.onState = () => {} // Host panel doesn't need state sync
    ws.onError = () => {}

    ws.connect()

    return () => ws.disconnect()
  }, [sessionId])

  const handleOpenSession = useCallback(() => {
    if (sessionUrl) {
      window.open(sessionUrl, '_blank')
    }
  }, [sessionUrl])

  const handleEndSession = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.sendCommand('end_session')
    }
  }, [])

  const handleCopyLink = useCallback(() => {
    if (sessionUrl && navigator.clipboard) {
      navigator.clipboard.writeText(sessionUrl)
    }
  }, [sessionUrl])

  if (!sessionId) return null

  return (
    <Paper className={classes.root} elevation={8}>
      <Box
        className={classes.header}
        onClick={() => setExpanded(!expanded)}
      >
        <HeadsetIcon className={classes.headerIcon} fontSize="small" />
        <Typography className={classes.headerTitle}>
          Listen Together
        </Typography>
        <Chip
          icon={<PersonIcon style={{ color: 'inherit' }} />}
          label={participants.length}
          size="small"
          style={{
            color: 'white',
            borderColor: 'rgba(255,255,255,0.5)',
            marginRight: 4,
          }}
          variant="outlined"
        />
        {expanded ? (
          <ExpandMore fontSize="small" />
        ) : (
          <ExpandLess fontSize="small" />
        )}
      </Box>

      <Collapse in={expanded}>
        <Box className={classes.content}>
          {!connected && (
            <Typography variant="caption" color="error">
              Reconnecting...
            </Typography>
          )}

          <Typography variant="caption" color="textSecondary">
            Participants:
          </Typography>
          {participants.map((p) => (
            <div key={p.id} className={classes.participant}>
              <PersonIcon fontSize="small" color="action" />
              <Typography variant="body2">
                {p.name}
                {p.id === myId && ' (you)'}
              </Typography>
              {remoteHolder.holderId === p.id && (
                <Chip label="🎮" size="small" variant="outlined" />
              )}
            </div>
          ))}

          <div className={classes.actions}>
            <Tooltip title="Open session page">
              <Button
                size="small"
                variant="outlined"
                startIcon={<OpenInNewIcon />}
                onClick={handleOpenSession}
              >
                Open
              </Button>
            </Tooltip>
            <Tooltip title="Copy session link">
              <Button
                size="small"
                variant="outlined"
                onClick={handleCopyLink}
              >
                Copy Link
              </Button>
            </Tooltip>
            <Tooltip title="End session">
              <Button
                size="small"
                variant="outlined"
                color="secondary"
                startIcon={<StopIcon />}
                onClick={handleEndSession}
              >
                End
              </Button>
            </Tooltip>
          </div>
        </Box>
      </Collapse>
    </Paper>
  )
}

export default ListenTogetherPanel
