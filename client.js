// Client side of the voice-input plugin: one microphone button in the composer
// activity seat (between the model selector and Send). Dictation is captured with
// WebAudio, posted as raw 16 kHz PCM to the Host route, and inserted as plain text.
window.__ModuleLoader__.load({
  id: '@local/dsh-voice-input',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    const API_BASE = '/api/dsh-voice-input'
    const TARGET_RATE = 16000
    const MIN_SAMPLES = TARGET_RATE * 0.3

    const CSS = `
.dvi-seat { display: inline-flex; align-items: center; position: relative; flex: 0 0 auto; width: 28px; height: 28px; }
.dvi-btn {
  width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; background: transparent; color: inherit; cursor: pointer;
  opacity: .72; padding: 0; transition: opacity .15s ease, background .15s ease, color .15s ease;
}
.dvi-btn:hover:not(:disabled) { opacity: 1; background: rgba(127,127,127,.16); }
.dvi-btn:disabled { opacity: .35; cursor: default; }
.dvi-btn[data-phase="listening"] { color: #e5484d; opacity: 1; background: rgba(229,72,77,.14); }
.dvi-btn[data-phase="uploading"] { opacity: 1; }
.dvi-dot {
  position: absolute; top: -1px; right: -1px; width: 7px; height: 7px; border-radius: 50%;
  background: #e5484d; animation: dvi-pulse 1.1s ease-in-out infinite;
}
@keyframes dvi-pulse { 0%,100% { transform: scale(.7); opacity: .5 } 50% { transform: scale(1.15); opacity: 1 } }
@keyframes dvi-spin { to { transform: rotate(360deg) } }
.dvi-spin { animation: dvi-spin .9s linear infinite; transform-origin: 50% 50%; }
.dvi-tip {
  position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
  max-width: min(420px, calc(100vw - 40px)); white-space: nowrap;
  padding: 6px 12px; border-radius: 9px; font-size: 12px; line-height: 1.4;
  background: rgba(24,24,28,.94); color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.32); z-index: 4001;
}
.dvi-overlay {
  position: fixed; inset: 0; z-index: 4000; display: flex; align-items: center; justify-content: center;
  background: rgba(8,8,12,.42); backdrop-filter: blur(2px);
}
.dvi-card {
  width: min(420px, calc(100vw - 32px)); border-radius: 14px; padding: 18px 18px 14px;
  background: #1d1d22; color: #f2f2f4; box-shadow: 0 18px 60px rgba(0,0,0,.45);
  font-size: 13px; line-height: 1.5; border: 1px solid rgba(255,255,255,.08);
}
.dvi-card h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.dvi-card p { margin: 0 0 14px; color: #a8a8b3; }
.dvi-field { display: block; margin-bottom: 12px; }
.dvi-field span { display: block; margin-bottom: 5px; color: #c9c9d2; }
.dvi-field input {
  width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,.14); background: #141418; color: #f2f2f4; font-size: 13px;
  outline: none;
}
.dvi-field input:focus { border-color: #5b8cff; }
.dvi-error { margin: 0 0 10px; color: #ff8b8b; word-break: break-word; }
.dvi-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.dvi-actions button {
  padding: 7px 16px; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.14); background: transparent; color: #e8e8ee;
}
.dvi-actions button.dvi-primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
.dvi-actions button:disabled { opacity: .6; cursor: default; }
`

    function icon(phase) {
      if (phase === 'uploading') {
        return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', className: 'dvi-spin' },
          h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 2.4, strokeOpacity: 0.25 }),
          h('path', { d: 'M21 12a9 9 0 0 0-9-9', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }))
      }
      return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none' },
        h('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3, stroke: 'currentColor', strokeWidth: 1.9 }),
        h('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }),
        h('path', { d: 'M12 17.5V21', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }))
    }

    function mergeChunks(chunks) {
      let total = 0
      for (const chunk of chunks) total += chunk.length
      const merged = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      return merged
    }

    function resampleLinear(input, from, to) {
      if (from === to || input.length === 0) return input
      const ratio = from / to
      const length = Math.max(1, Math.round(input.length / ratio))
      const output = new Float32Array(length)
      for (let i = 0; i < length; i += 1) {
        const position = i * ratio
        const left = Math.floor(position)
        const right = Math.min(left + 1, input.length - 1)
        const weight = position - left
        output[i] = input[left] * (1 - weight) + input[right] * weight
      }
      return output
    }

    function toPcm16(samples) {
      const buffer = new ArrayBuffer(samples.length * 2)
      const view = new DataView(buffer)
      for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      }
      return new Uint8Array(buffer)
    }

    async function requestConfig() {
      const response = await fetch(`${window.location.origin}${API_BASE}/config`, { headers: { accept: 'application/json' } })
      return response.json()
    }

    function VoiceButton(props) {
      const inputActions = props && props.inputActions
      const locked = Boolean(props && props.locked)
      const onActiveChange = props && props.onActiveChange

      const [phase, setPhase] = React.useState('idle')
      const [tip, setTip] = React.useState('')
      const [dialogOpen, setDialogOpen] = React.useState(false)
      const [apiKey, setApiKey] = React.useState('')
      const [resourceId, setResourceId] = React.useState('volc.seedasr.sauc.duration')
      const [dialogError, setDialogError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [configured, setConfigured] = React.useState(null)

      const recorder = React.useRef(null)
      const tipTimer = React.useRef(0)

      const flash = React.useCallback((message) => {
        setTip(message)
        if (tipTimer.current) window.clearTimeout(tipTimer.current)
        tipTimer.current = window.setTimeout(() => setTip(''), 4000)
      }, [])

      React.useEffect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-voice-input', '')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
          if (tipTimer.current) window.clearTimeout(tipTimer.current)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        requestConfig()
          .then((info) => {
            if (!alive) return
            setConfigured(Boolean(info && info.configured))
            if (info && typeof info.resourceId === 'string') setResourceId(info.resourceId)
          })
          .catch(() => {
            if (alive) setConfigured(false)
          })
        return () => {
          alive = false
        }
      }, [])

      const discardRecorder = React.useCallback(async () => {
        const current = recorder.current
        recorder.current = null
        if (!current) return null
        try { current.processor.disconnect() } catch { /* detached */ }
        try { current.source.disconnect() } catch { /* detached */ }
        try { current.sink.disconnect() } catch { /* detached */ }
        for (const track of current.stream.getTracks()) {
          try { track.stop() } catch { /* already stopped */ }
        }
        try { await current.audioCtx.close() } catch { /* already closed */ }
        return current
      }, [])

      React.useEffect(() => () => {
        discardRecorder()
        if (typeof onActiveChange === 'function') onActiveChange(false)
      }, [discardRecorder, onActiveChange])

      const insertText = React.useCallback(async (text, captured) => {
        if (!inputActions || typeof inputActions.insertText !== 'function') {
          try {
            await navigator.clipboard.writeText(text)
            flash('识别结果已复制到剪贴板')
          } catch {
            flash(text)
          }
          return
        }
        try {
          const span = captured && typeof captured === 'object' && captured.span !== undefined
            ? captured.span
            : captured
          const outcome = await Promise.resolve(inputActions.insertText(text, span))
          if (outcome && outcome.ok === false) throw new Error('insert rejected')
        } catch {
          try {
            await navigator.clipboard.writeText(text)
            flash('听写期间草稿被改过，文字已复制到剪贴板')
          } catch {
            flash(text)
          }
        }
      }, [inputActions, flash])

      const stop = React.useCallback(async () => {
        const current = await discardRecorder()
        if (!current) {
          setPhase('idle')
          return
        }
        const merged = mergeChunks(current.chunks)
        if (merged.length < MIN_SAMPLES) {
          setPhase('idle')
          flash('没识别到说话内容')
          return
        }
        setPhase('uploading')
        try {
          const pcm = toPcm16(resampleLinear(merged, current.sampleRate, TARGET_RATE))
          const response = await fetch(`${window.location.origin}${API_BASE}/transcribe?rate=${TARGET_RATE}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: pcm,
          })
          const data = await response.json()
          if (!data || !data.ok) throw new Error((data && data.error) || '识别失败')
          const text = typeof data.text === 'string' ? data.text.trim() : ''
          if (text.length === 0) {
            flash('没识别到说话内容')
            return
          }
          await insertText(text, current.captured)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          flash(message)
          if (/not granted|403|401|unauthor|未授权|鉴权/i.test(message)) {
            setDialogError(message)
            setDialogOpen(true)
          }
        } finally {
          setPhase('idle')
        }
      }, [discardRecorder, flash, insertText])

      // Recording swallows Space: the key ends the take instead of typing a blank into the draft.
      React.useEffect(() => {
        if (phase !== 'listening') return undefined
        const onKeyDown = (event) => {
          if (event.code !== 'Space' && event.key !== ' ') return
          if (event.isComposing || event.repeat) return
          event.preventDefault()
          event.stopPropagation()
          stop()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [phase, stop])

      const start = React.useCallback(async () => {
        if (phase !== 'idle') return
        if (locked) return
        if (configured === false) {
          setDialogError('')
          setDialogOpen(true)
          return
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          })
          const AudioCtor = window.AudioContext || window.webkitAudioContext
          if (!AudioCtor) throw new Error('当前浏览器不支持录音')
          const audioCtx = new AudioCtor({ sampleRate: TARGET_RATE })
          if (audioCtx.state === 'suspended') await audioCtx.resume()
          const source = audioCtx.createMediaStreamSource(stream)
          const processor = audioCtx.createScriptProcessor(4096, 1, 1)
          const sink = audioCtx.createGain()
          sink.gain.value = 0
          const chunks = []
          processor.onaudioprocess = (event) => {
            chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
          }
          source.connect(processor)
          processor.connect(sink)
          sink.connect(audioCtx.destination)
          const captured = inputActions && typeof inputActions.captureInsertion === 'function'
            ? inputActions.captureInsertion()
            : undefined
          recorder.current = { audioCtx, source, processor, sink, stream, chunks, sampleRate: audioCtx.sampleRate, captured }
          setPhase('listening')
          setConfigured(true)
        } catch (error) {
          setPhase('idle')
          flash('麦克风权限被拒绝了')
        }
      }, [phase, locked, configured, inputActions, flash])

      const saveConfig = React.useCallback(async () => {
        const trimmed = apiKey.trim()
        if (trimmed.length === 0) {
          setDialogError('API Key 不能为空')
          return
        }
        setSaving(true)
        setDialogError('')
        try {
          const response = await fetch(`${window.location.origin}${API_BASE}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: trimmed, resourceId: resourceId.trim() || undefined }),
          })
          const data = await response.json()
          if (!data || !data.ok) throw new Error((data && data.error) || '保存失败')
          setConfigured(true)
          setDialogOpen(false)
          setApiKey('')
          flash('已保存，可以开始说话了')
        } catch (error) {
          setDialogError(error instanceof Error ? error.message : String(error))
        } finally {
          setSaving(false)
        }
      }, [apiKey, resourceId, flash])

      const onClick = (event) => {
        event.preventDefault()
        if (locked) return
        if (phase === 'listening') {
          stop()
          return
        }
        if (phase === 'uploading') return
        start()
      }

      const onContextMenu = (event) => {
        event.preventDefault()
        setDialogOpen(true)
        setDialogError('')
      }

      const dialog = dialogOpen
        ? h('div', {
          className: 'dvi-overlay',
          onClick: () => { if (!saving) setDialogOpen(false) },
        },
        h('div', { className: 'dvi-card', onClick: (event) => event.stopPropagation() },
          h('h3', null, '豆包语音识别'),
          h('p', null, '把火山引擎控制台的 API Key 填一次就行，会存成凭据记录，不写进配置文件。'),
          h('label', { className: 'dvi-field' },
            h('span', null, 'API Key'),
            h('input', {
              type: 'password',
              value: apiKey,
              autoFocus: true,
              spellCheck: false,
              placeholder: '粘贴 X-Api-Key',
              onChange: (event) => setApiKey(event.target.value),
            })),
          h('label', { className: 'dvi-field' },
            h('span', null, 'Resource ID'),
            h('input', {
              value: resourceId,
              spellCheck: false,
              onChange: (event) => setResourceId(event.target.value),
            })),
          dialogError ? h('p', { className: 'dvi-error' }, dialogError) : null,
          h('div', { className: 'dvi-actions' },
            h('button', { type: 'button', onClick: () => setDialogOpen(false), disabled: saving }, '取消'),
            h('button', { type: 'button', className: 'dvi-primary', onClick: saveConfig, disabled: saving },
              saving ? '保存中…' : '保存'))))
        : null

      return h('div', { className: 'dvi-seat' },
        h('button', {
          type: 'button',
          className: 'dvi-btn',
          'data-phase': phase,
          title: phase === 'listening' ? '点一下结束说话' : '语音输入（右键设置 API Key）',
          'aria-label': '语音输入',
          disabled: locked,
          onClick,
          onContextMenu,
        },
        icon(phase),
        phase === 'listening' ? h('span', { className: 'dvi-dot' }) : null),
        tip ? h('div', { className: 'dvi-tip' }, tip) : null,
        dialog && ReactDOM && typeof ReactDOM.createPortal === 'function'
          ? ReactDOM.createPortal(dialog, document.body)
          : dialog)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
          name: 'conversation.input.activity',
          id: 'dsh-voice-input',
          order: 40,
        }, VoiceButton))
      },
    }
  },
})
