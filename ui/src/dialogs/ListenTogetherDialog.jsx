import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  TextField,
} from '@material-ui/core'
import { SimpleForm, TextInput, useNotify, useTranslate } from 'react-admin'
import { useEffect, useState } from 'react'
import { useTranscodingOptions } from './useTranscodingOptions'
import { useDispatch, useSelector } from 'react-redux'
import { closeListenTogetherDialog } from '../actions'
import FileCopyOutlinedIcon from '@material-ui/icons/FileCopyOutlined'
import OpenInNewIcon from '@material-ui/icons/OpenInNew'
import config from '../config'

export const ListenTogetherDialog = () => {
  const { open, ids, resource, name } = useSelector(
    (state) => state.listenTogetherDialog,
  )
  const dispatch = useDispatch()
  const notify = useNotify()
  const translate = useTranslate()
  const [description, setDescription] = useState('')
  const [sessionUrl, setSessionUrl] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    setDescription('')
    setSessionUrl('')
  }, [ids])

  const { TranscodingOptionsInput, format, maxBitRate, originalFormat } =
    useTranscodingOptions()

  const handleCreate = async (e) => {
    e.stopPropagation()
    setCreating(true)
    try {
      const token = localStorage.getItem('token')
      const body = {
        resourceIds: ids?.join(','),
        resourceType: resource,
        description,
        ...(!originalFormat && { format }),
        ...(!originalFormat && { maxBitRate }),
      }
      const response = await fetch(
        config.baseURL + '/api/listenTogether',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-nd-authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
      )
      if (!response.ok) {
        throw new Error('Failed to create session')
      }
      const data = await response.json()
      setSessionUrl(data.url)
      notify('resources.listenTogether.notifications.created', {
        type: 'info',
        messageArgs: { _: 'Listen Together session created!' },
      })
    } catch (error) {
      notify(error.message, { type: 'warning' })
    } finally {
      setCreating(false)
    }
  }

  const handleCopyUrl = () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(sessionUrl).then(() => {
        notify('resources.listenTogether.notifications.copied', {
          type: 'info',
          messageArgs: { _: 'Link copied to clipboard!' },
        })
      })
    } else {
      prompt('Copy this link:', sessionUrl)
    }
  }

  const handleOpenSession = () => {
    window.open(sessionUrl, '_blank')
  }

  const handleClose = (e) => {
    dispatch(closeListenTogetherDialog())
    e.stopPropagation()
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      aria-labelledby="listen-together-dialog"
      fullWidth={true}
      maxWidth={'sm'}
    >
      <DialogTitle id="listen-together-dialog">
        {translate('resources.listenTogether.dialogTitle', {
          _: 'Listen Together',
          name,
        })}
      </DialogTitle>
      <DialogContent>
        {!sessionUrl ? (
          <SimpleForm toolbar={null} variant={'outlined'}>
            <TextInput
              source={'description'}
              label={translate('resources.listenTogether.fields.description', {
                _: 'Session Description',
              })}
              fullWidth
              onChange={(event) => {
                setDescription(event.target.value)
              }}
            />
            <TranscodingOptionsInput
              fullWidth
              label={translate('message.shareOriginalFormat')}
            />
          </SimpleForm>
        ) : (
          <div>
            <TextField
              label={translate('resources.listenTogether.fields.sessionUrl', {
                _: 'Session URL',
              })}
              value={sessionUrl}
              fullWidth
              variant="outlined"
              margin="normal"
              InputProps={{
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={handleCopyUrl}
                      size="small"
                      title="Copy URL"
                    >
                      <FileCopyOutlinedIcon />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </div>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} color="primary">
          {translate('ra.action.close')}
        </Button>
        {!sessionUrl ? (
          <Button
            onClick={handleCreate}
            color="primary"
            disabled={creating}
          >
            {translate('resources.listenTogether.actions.create', {
              _: 'Create Session',
            })}
          </Button>
        ) : (
          <Button
            onClick={handleOpenSession}
            color="primary"
            startIcon={<OpenInNewIcon />}
          >
            {translate('resources.listenTogether.actions.openSession', {
              _: 'Open Session',
            })}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
