import { ChangeEvent, CSSProperties, DragEvent, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Check,
  CircleStop,
  Film,
  Images,
  Link2,
  LoaderCircle,
  Palette,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Type,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import ImageWorkspace from './ImageWorkspace'
import TextBannerWorkspace from './TextBannerWorkspace'
import { mediaStylePresets, MediaStyleKey } from './mediaStyles'

type JobStatus = 'ready' | 'processing' | 'completed' | 'cancelled' | 'error'

interface VideoInfo {
  width: number
  height: number
  duration: number
  fps: number
  has_audio: boolean
}

interface Job {
  id: string
  status: JobStatus
  stage: string
  progress: number
  message: string | null
  video: VideoInfo
  preview_url: string | null
  result_url: string | null
  result_format: 'mp4' | 'gif' | null
  source_url: string | null
  source_format: 'mp4' | 'gif' | null
}

interface Options {
  grid_width: number
  character_size: number
  contrast: number
  brightness: number
  invert: boolean
  character_color: string
  background_color: string
  character_set: 'console' | 'classic' | 'detailed' | 'minimal' | 'braille'
  fps: number
  quality: 'draft' | 'balanced' | 'high'
  output_format: 'mp4' | 'gif'
  keep_audio: boolean
  mode: 'monochrome' | 'original_colors'
  normalize_contrast: boolean
  temporal_smoothing: number
}

interface ModelContext {
  registerTool: (
    tool: {
      name: string
      title: string
      description: string
      inputSchema: Record<string, unknown>
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }
      execute: (input: unknown) => unknown | Promise<unknown>
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>
}

type WebMcpDocument = Document & { modelContext?: ModelContext }

const defaults: Options = {
  grid_width: 96,
  character_size: 10,
  contrast: 1.2,
  brightness: 0,
  invert: false,
  character_color: '#e9ecef',
  background_color: '#050607',
  character_set: 'console',
  fps: 20,
  quality: 'balanced',
  output_format: 'mp4',
  keep_audio: true,
  mode: 'monochrome',
  normalize_contrast: true,
  temporal_smoothing: 0.2,
}

const stageLabels: Record<string, string> = {
  uploading: 'Загрузка',
  uploaded: 'Загружено',
  extracting: 'Извлечение кадров',
  converting: 'Преобразование',
  assembling: 'Сборка видео',
  cancelling: 'Отмена',
  cancelled: 'Отменено',
  completed: 'Готово',
  error: 'Ошибка',
}

const processStages = ['extracting', 'converting', 'assembling', 'completed']

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return 'Что-то пошло не так. Попробуйте ещё раз.'
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json()
    return body.detail || body.message || `Ошибка ${response.status}`
  } catch {
    return `Ошибка ${response.status}`
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} МБ`
    : `${Math.ceil(bytes / 1024)} КБ`
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="range-control">
      <span>
        {label}
        <output>{value}{suffix}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--range-progress': `${progress}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className={`toggle-row ${disabled ? 'disabled' : ''}`}>
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true"><span /></span>
    </label>
  )
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const previewRequest = useRef(0)
  const sourceUrlRef = useRef<string | null>(null)
  const jobRef = useRef<Job | null>(null)
  const optionsRef = useRef<Options>(defaults)
  const [dragging, setDragging] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteSourceLabel, setRemoteSourceLabel] = useState<string | null>(null)
  const [importingUrl, setImportingUrl] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [options, setOptions] = useState<Options>(defaults)
  const [timestamp, setTimestamp] = useState(0)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [maxUploadMb, setMaxUploadMb] = useState(200)
  const [activeTab, setActiveTab] = useState<'video' | 'image' | 'banner'>('video')
  const [stylePreset, setStylePreset] = useState<MediaStyleKey | null>('classic')

  jobRef.current = job
  optionsRef.current = options

  const patchOptions = <K extends keyof Options>(key: K, value: Options[K]) => {
    if (['grid_width', 'character_size', 'contrast', 'brightness', 'invert', 'character_color', 'background_color', 'character_set', 'mode', 'normalize_contrast', 'temporal_smoothing'].includes(key)) {
      setStylePreset(null)
    }
    setOptions((current) => ({ ...current, [key]: value }))
  }

  const applyStylePreset = (key: MediaStyleKey) => {
    const preset = mediaStylePresets.find((item) => item.key === key)
    if (!preset) return
    setStylePreset(key)
    setOptions((current) => ({ ...current, ...preset.video }))
  }

  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return response.json()
      })
      .then((health) => {
        if (health.limits?.max_upload_mb) setMaxUploadMb(health.limits.max_upload_mb)
        if (!health.ok && health.message) setMessage(health.message)
      })
      .catch(() => undefined)
    return () => {
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
    }
  }, [])

  useEffect(() => {
    const context = (document as WebMcpDocument).modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    const register = (tool: Parameters<ModelContext['registerTool']>[0]) => {
      try {
        void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined)
      } catch {
        // WebMCP is optional and must never interrupt the visible workflow.
      }
    }

    register({
      name: 'configure_ascii_effect',
      title: 'Настроить ASCII-эффект',
      description: 'Apply valid rendering settings to the visible ASCII video editor before export.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['monochrome', 'original_colors'] },
          grid_width: { type: 'integer', minimum: 32, maximum: 200 },
          character_size: { type: 'integer', minimum: 8, maximum: 20 },
          contrast: { type: 'number', minimum: 0.5, maximum: 3 },
          brightness: { type: 'integer', minimum: -100, maximum: 100 },
          fps: { type: 'integer', minimum: 6, maximum: 60 },
          quality: { type: 'string', enum: ['draft', 'balanced', 'high'] },
          output_format: { type: 'string', enum: ['mp4', 'gif'] },
          keep_audio: { type: 'boolean' },
          invert: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.')
        const candidate = input as Partial<Options>
        const patch: Partial<Options> = {}
        const enumValue = <K extends 'mode' | 'quality' | 'output_format'>(key: K, allowed: readonly Options[K][]) => {
          const value = candidate[key]
          if (value !== undefined) {
            if (!allowed.includes(value)) throw new Error(`Invalid ${key}.`)
            patch[key] = value as never
          }
        }
        const numberValue = (key: 'grid_width' | 'character_size' | 'contrast' | 'brightness' | 'fps', min: number, max: number) => {
          const value = candidate[key]
          if (value !== undefined) {
            if (typeof value !== 'number' || value < min || value > max) throw new Error(`Invalid ${key}.`)
            patch[key] = value as never
          }
        }
        enumValue('mode', ['monochrome', 'original_colors'])
        enumValue('quality', ['draft', 'balanced', 'high'])
        enumValue('output_format', ['mp4', 'gif'])
        numberValue('grid_width', 32, 200)
        numberValue('character_size', 8, 20)
        numberValue('contrast', 0.5, 3)
        numberValue('brightness', -100, 100)
        numberValue('fps', 6, 60)
        for (const key of ['keep_audio', 'invert'] as const) {
          const value = candidate[key]
          if (value !== undefined) {
            if (typeof value !== 'boolean') throw new Error(`Invalid ${key}.`)
            patch[key] = value
          }
        }
        const next = { ...optionsRef.current, ...patch }
        optionsRef.current = next
        setStylePreset(null)
        setOptions(next)
        return { applied: Object.keys(patch), preview_updates_automatically: jobRef.current?.status === 'ready' }
      },
    })

    register({
      name: 'start_ascii_conversion',
      title: 'Запустить ASCII-конвертацию',
      description: 'Start the full conversion for the MP4 or GIF already uploaded in the visible editor.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
          throw new Error('This tool does not accept arguments.')
        }
        const currentJob = jobRef.current
        if (!currentJob || currentJob.status !== 'ready') throw new Error('Upload an MP4 or GIF and wait for its preview first.')
        const response = await fetch(`/api/jobs/${currentJob.id}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(optionsRef.current),
        })
        if (!response.ok) throw new Error(await responseError(response))
        const nextJob: Job = await response.json()
        setJob(nextJob)
        return { job_id: nextJob.id, status: nextJob.status, progress: nextJob.progress }
      },
    })

    return () => lifecycle.abort()
  }, [])

  useEffect(() => {
    if (!job || !['processing'].includes(job.status)) return
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(await responseError(response))
        setJob(await response.json())
      } catch (error) {
        setMessage(errorMessage(error))
      }
    }, 800)
    return () => window.clearInterval(poll)
  }, [job?.id, job?.status])

  useEffect(() => {
    if (!job || job.status !== 'ready') return
    const requestId = ++previewRequest.current
    const timer = window.setTimeout(async () => {
      setPreviewing(true)
      try {
        const response = await fetch(`/api/jobs/${job.id}/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...options, timestamp }),
        })
        if (!response.ok) throw new Error(await responseError(response))
        const nextJob: Job = await response.json()
        if (requestId === previewRequest.current) {
          setJob(nextJob)
          setPreviewUrl(nextJob.preview_url)
          setMessage(null)
        }
      } catch (error) {
        if (requestId === previewRequest.current) setMessage(errorMessage(error))
      } finally {
        if (requestId === previewRequest.current) setPreviewing(false)
      }
    }, 450)
    return () => window.clearTimeout(timer)
  }, [job?.id, job?.status, options, timestamp])

  async function disposePreviousJob() {
    if (!job) return
    try {
      await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' })
    } catch {
      // The server also cleans each conversion's temporary files.
    }
  }

  async function chooseFile(nextFile?: File) {
    if (!nextFile) return
    const extension = nextFile.name.toLowerCase().slice(nextFile.name.lastIndexOf('.'))
    const validMime = !nextFile.type
      || (extension === '.mp4' && nextFile.type === 'video/mp4')
      || (extension === '.gif' && nextFile.type === 'image/gif')
    if (!['.mp4', '.gif'].includes(extension) || !validMime) {
      setMessage('Выберите видео MP4 или анимированный GIF.')
      return
    }
    if (nextFile.size > maxUploadMb * 1024 * 1024) {
      setMessage(`Файл превышает лимит ${maxUploadMb} МБ.`)
      return
    }
    await disposePreviousJob()
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
    const nextSourceUrl = URL.createObjectURL(nextFile)
    sourceUrlRef.current = nextSourceUrl
    setFile(nextFile)
    setSourceUrl(nextSourceUrl)
    setRemoteUrl('')
    setRemoteSourceLabel(null)
    setJob(null)
    setPreviewUrl(null)
    setMessage(null)
    setTimestamp(0)
    setUploading(true)
    setUploadProgress(0)

    const form = new FormData()
    form.append('file', nextFile)
    const request = new XMLHttpRequest()
    request.open('POST', '/api/jobs')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onload = () => {
      setUploading(false)
      if (request.status >= 200 && request.status < 300) {
        const nextJob: Job = JSON.parse(request.responseText)
        setJob(nextJob)
        setUploadProgress(100)
      } else {
        try {
          setMessage(JSON.parse(request.responseText).detail || 'Не удалось загрузить видео.')
        } catch {
          setMessage('Не удалось загрузить видео.')
        }
      }
    }
    request.onerror = () => {
      setUploading(false)
      setMessage('Сервер недоступен. Проверьте, что backend запущен на порту 8000.')
    }
    request.send(form)
  }

  async function importVideoUrl() {
    const value = remoteUrl.trim()
    try {
      const parsed = new URL(value)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error()
    } catch {
      setMessage('Введите корректную прямую HTTP- или HTTPS-ссылку.')
      return
    }

    setImportingUrl(true)
    setMessage(null)
    try {
      const response = await fetch('/api/jobs/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const nextJob: Job = await response.json()
      await disposePreviousJob()
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
      sourceUrlRef.current = null
      const parsed = new URL(value)
      const pathParts = parsed.pathname.split('/').filter(Boolean)
      const pathName = decodeURIComponent(pathParts[pathParts.length - 1] || '')
      setFile(null)
      setSourceUrl(nextJob.source_url)
      setRemoteSourceLabel(pathName || parsed.hostname)
      setJob(nextJob)
      setPreviewUrl(null)
      setTimestamp(0)
      setUploadProgress(0)
      setMessage(null)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setImportingUrl(false)
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    void chooseFile(event.dataTransfer.files[0])
  }

  async function startProcessing() {
    if (!job) return
    setMessage(null)
    try {
      const response = await fetch(`/api/jobs/${job.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      })
      if (!response.ok) throw new Error(await responseError(response))
      setJob(await response.json())
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  async function cancelProcessing() {
    if (!job) return
    try {
      const response = await fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' })
      if (!response.ok) throw new Error(await responseError(response))
      setJob(await response.json())
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  function reset() {
    void disposePreviousJob()
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
    sourceUrlRef.current = null
    setFile(null)
    setSourceUrl(null)
    setRemoteUrl('')
    setRemoteSourceLabel(null)
    setJob(null)
    setPreviewUrl(null)
    setMessage(null)
    setUploadProgress(0)
    if (inputRef.current) inputRef.current.value = ''
  }

  const isProcessing = job?.status === 'processing'
  const resultUrl = job?.result_url ? `${job.result_url}?inline=1` : null
  const selectedOutputFormat = options.output_format || 'mp4'
  const resultFormat = job?.result_format || selectedOutputFormat
  const isGif = job?.source_format === 'gif' || (file?.name.toLowerCase().endsWith('.gif') ?? false)
  const mediaAspect = job?.video ? { '--media-aspect': `${job.video.width} / ${job.video.height}` } as CSSProperties : undefined

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ASCII Motion — к началу">
          <span className="brand-mark">A:</span>
          <span>ASCII MOTION</span>
        </a>
        <div className="privacy"><span /> Обработка только на этом сервере</div>
      </header>

      <main id="top">
        <section className="intro">
          <div>
            <p className="eyebrow">MEDIA → ASCII / FRAME BY FRAME</p>
            <h1>Медиа, собранное<br />из символов.</h1>
          </div>
          <p className="intro-copy">Преобразуйте видео, GIF, изображения или фразы в разные виды ASCII-арта. Результат можно скачать как MP4, GIF, PNG или текст.</p>
        </section>

        <div className="surface-tabs" role="tablist" aria-label="Тип исходного файла">
          <button type="button" role="tab" aria-selected={activeTab === 'video'} className={activeTab === 'video' ? 'active' : ''} onClick={() => setActiveTab('video')}><Film size={18} /> Видео и GIF <span>MP4 / GIF</span></button>
          <button type="button" role="tab" aria-selected={activeTab === 'image'} className={activeTab === 'image' ? 'active' : ''} onClick={() => setActiveTab('image')}><Images size={18} /> Изображения <span>PNG / JPG / WEBP</span></button>
          <button type="button" role="tab" aria-selected={activeTab === 'banner'} className={activeTab === 'banner' ? 'active' : ''} onClick={() => setActiveTab('banner')}><Type size={18} /> Текстовый баннер <span>TXT / PNG</span></button>
        </div>

        <div className="workspace" hidden={activeTab !== 'video'}>
          <section className="stage-column" aria-label="Видео">
            {!file && !job ? (
              <div
                className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
                onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <div className="drop-icon"><Upload size={28} strokeWidth={1.7} /></div>
                <h2>Перетащите MP4 или GIF</h2>
                <p>До {maxUploadMb} МБ · до 5 минут</p>
                <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>
                  <Film size={17} /> Выбрать видео
                </button>
                <input
                  ref={inputRef}
                  className="visually-hidden"
                  type="file"
                  accept="video/mp4,image/gif,.mp4,.gif"
                  onChange={(event: ChangeEvent<HTMLInputElement>) => void chooseFile(event.target.files?.[0])}
                />
                <div className="or-divider"><span>или</span></div>
                <form className="url-import" onSubmit={(event) => { event.preventDefault(); void importVideoUrl() }}>
                  <input
                    type="url"
                    inputMode="url"
                    value={remoteUrl}
                    placeholder="https://example.com/video.mp4"
                    aria-label="Прямая ссылка на видео или GIF"
                    onChange={(event) => setRemoteUrl(event.target.value)}
                  />
                  <button type="submit" disabled={importingUrl || !remoteUrl.trim()}>
                    {importingUrl ? <LoaderCircle className="spin" size={17} /> : <Link2 size={17} />}
                    {importingUrl ? 'Импорт…' : 'Добавить URL'}
                  </button>
                </form>
                <small className="url-hint">Прямая ссылка на файл MP4 или GIF</small>
              </div>
            ) : (
              <>
                <div className="file-strip">
                  <div className="file-icon"><Film size={19} /></div>
                  <div>
                    <strong>{file?.name || remoteSourceLabel || 'Видео по ссылке'}</strong>
                    <span>{file ? formatSize(file.size) : 'Импортировано по URL'}{job?.video ? ` · ${job.video.width}×${job.video.height} · ${formatDuration(job.video.duration)}` : ''}</span>
                  </div>
                  <button type="button" onClick={reset} disabled={isProcessing} aria-label="Удалить видео"><X size={18} /></button>
                </div>

                {uploading && (
                  <div className="upload-state">
                    <div><span>Загрузка</span><strong>{uploadProgress}%</strong></div>
                    <div className="progress-track"><span style={{ width: `${uploadProgress}%` }} /></div>
                  </div>
                )}

                {job && !uploading && (
                  <div className="media-grid adaptive-media-grid" style={mediaAspect}>
                    <article className="media-card">
                      <div className="card-label"><span>01</span> Исходник</div>
                      {sourceUrl && (isGif
                        ? <img className="source-gif" src={sourceUrl} alt="Исходная GIF-анимация" />
                        : <video controls playsInline src={sourceUrl} />
                      )}
                    </article>
                    <article className="media-card result-card">
                      <div className="card-label"><span>02</span> ASCII-кадр</div>
                      <div className="preview-surface" style={{ backgroundColor: options.background_color }}>
                        {previewUrl ? (
                          <img src={previewUrl} alt="Предпросмотр ASCII-эффекта" />
                        ) : (
                          <div className="preview-placeholder"><span>@#S%?*+</span><p>Готовим кадр</p></div>
                        )}
                        {previewing && <div className="preview-loader"><LoaderCircle className="spin" size={22} /> Обновление</div>}
                      </div>
                    </article>
                  </div>
                )}

                {job?.video && job.status === 'ready' && (
                  <RangeControl
                    label="Кадр предпросмотра"
                    value={Number(timestamp.toFixed(1))}
                    min={0}
                    max={Math.max(0.1, job.video.duration - 0.1)}
                    step={0.1}
                    suffix=" с"
                    onChange={setTimestamp}
                  />
                )}
              </>
            )}

            {message && <div className="message error-message" role="alert">{message}</div>}

            {job && (isProcessing || job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') && (
              <section className="process-panel" aria-live="polite">
                <div className="process-heading">
                  <div>
                    <span>{stageLabels[job.stage] || job.stage}</span>
                    <strong>{job.progress}%</strong>
                  </div>
                  {isProcessing && (
                    <button type="button" className="cancel-button" onClick={cancelProcessing}><CircleStop size={16} /> Отменить</button>
                  )}
                </div>
                <div className="progress-track large"><span style={{ width: `${job.progress}%` }} /></div>
                <ol className="stage-list">
                  {processStages.map((stage, index) => {
                    const current = processStages.indexOf(job.stage)
                    const done = job.status === 'completed' || (current >= 0 && index < current)
                    const active = stage === job.stage
                    return <li key={stage} className={done ? 'done' : active ? 'active' : ''}><i>{done ? <Check size={12} /> : index + 1}</i>{stageLabels[stage]}</li>
                  })}
                </ol>
                {job.message && <p className="process-message">{job.message}</p>}
              </section>
            )}

            {job?.status === 'completed' && resultUrl && (
              <section className="final-result adaptive-final-result" style={mediaAspect}>
                <div className="card-label"><span>03</span> Готовый результат</div>
                {resultFormat === 'gif'
                  ? <img className="result-gif" src={resultUrl} alt="Готовая ASCII GIF-анимация" />
                  : <video controls playsInline src={resultUrl} />
                }
                <a className="download-button" href={job.result_url!} download={resultFormat === 'gif' ? 'ascii-animation.gif' : 'ascii-video.mp4'}>
                  <ArrowDownToLine size={18} /> Скачать {resultFormat.toUpperCase()}
                </a>
              </section>
            )}
          </section>

          <aside className="settings-panel" aria-label="Настройки ASCII">
            <div className="panel-title"><SlidersHorizontal size={18} /><h2>Настройки</h2><button type="button" onClick={() => { setOptions(defaults); setStylePreset('classic') }} title="Сбросить"><RefreshCw size={15} /></button></div>

            <div className="style-section-title">Стиль ASCII</div>
            <div className="style-presets" role="group" aria-label="Стиль ASCII-видео">
              {mediaStylePresets.map((preset) => (
                <button key={preset.key} type="button" aria-pressed={stylePreset === preset.key} className={`${stylePreset === preset.key ? 'active' : ''} style-${preset.key}`} onClick={() => applyStylePreset(preset.key)}>
                  <span className="style-sample">{preset.sample}</span>
                  <strong>{preset.title}</strong>
                  <small>{preset.description}</small>
                </button>
              ))}
            </div>

            <div className="color-mode-label">
              <Palette size={17} />
              <span><strong>Цвет символов</strong><small>Выберите вид готового видео</small></span>
            </div>
            <fieldset className="segmented color-mode-segmented">
              <legend>Режим цвета</legend>
              <button type="button" aria-pressed={options.mode === 'monochrome'} className={options.mode === 'monochrome' ? 'active' : ''} onClick={() => patchOptions('mode', 'monochrome')}>Чёрно-белое</button>
              <button type="button" aria-pressed={options.mode === 'original_colors'} className={options.mode === 'original_colors' ? 'active' : ''} onClick={() => patchOptions('mode', 'original_colors')}>Цветное</button>
            </fieldset>
            <p className={`color-mode-help ${options.mode === 'original_colors' ? 'is-color' : ''}`}>
              <span aria-hidden="true" />
              {options.mode === 'original_colors' ? 'Каждый символ получит цвет соответствующей области исходного кадра.' : 'Все символы будут одного выбранного цвета.'}
            </p>

            <div className="controls-group">
              <RangeControl label="Ширина сетки" value={options.grid_width} min={32} max={200} onChange={(value) => patchOptions('grid_width', value)} />
              <RangeControl label="Размер символа" value={options.character_size} min={8} max={20} suffix=" px" onChange={(value) => patchOptions('character_size', value)} />
              <RangeControl label="Контраст" value={options.contrast} min={0.5} max={3} step={0.1} suffix="×" onChange={(value) => patchOptions('contrast', value)} />
              <RangeControl label="Яркость" value={options.brightness} min={-100} max={100} onChange={(value) => patchOptions('brightness', value)} />
            </div>

            <div className="select-grid">
              <label className="wide-select"><span>Формат результата</span><select value={selectedOutputFormat} onChange={(event) => patchOptions('output_format', event.target.value as Options['output_format'])}><option value="mp4">MP4 · видео со звуком</option><option value="gif">GIF · зацикленная анимация</option></select></label>
              <label className="wide-select"><span>Набор символов</span><select value={options.character_set} onChange={(event) => patchOptions('character_set', event.target.value as Options['character_set'])}><option value="console">Console dense</option><option value="classic">Classic</option><option value="detailed">Detailed</option><option value="minimal">Minimal</option><option value="braille">Unicode / Braille 2×4</option></select></label>
              <label><span>FPS результата</span><select value={options.fps} onChange={(event) => patchOptions('fps', Number(event.target.value))}><option value="12">12 FPS</option><option value="20">20 FPS</option><option value="24">24 FPS</option><option value="30">30 FPS</option><option value="60">60 FPS</option></select></label>
              <label><span>Качество MP4</span><select disabled={selectedOutputFormat === 'gif'} value={options.quality} onChange={(event) => patchOptions('quality', event.target.value as Options['quality'])}><option value="draft">Черновик</option><option value="balanced">Баланс</option><option value="high">Высокое</option></select></label>
            </div>

            {options.mode === 'monochrome' && <div className="color-row"><label><span>Символы</span><input type="color" value={options.character_color} onChange={(event) => patchOptions('character_color', event.target.value)} /></label><label><span>Фон</span><input type="color" value={options.background_color} onChange={(event) => patchOptions('background_color', event.target.value)} /></label></div>}

            <div className="toggle-group">
              <Toggle checked={options.invert} onChange={(value) => patchOptions('invert', value)} label="Инверсия яркости" />
              <Toggle checked={options.normalize_contrast} onChange={(value) => patchOptions('normalize_contrast', value)} label="Автоконтраст" />
              <Toggle disabled={selectedOutputFormat === 'gif'} checked={options.keep_audio} onChange={(value) => patchOptions('keep_audio', value)} label="Сохранить звук" hint={selectedOutputFormat === 'gif' ? 'Формат GIF не поддерживает звук' : job?.video && !job.video.has_audio ? 'В исходнике нет звуковой дорожки' : options.keep_audio ? 'Оригинальная дорожка' : 'Видео без звука'} />
            </div>

            <RangeControl label="Сглаживание мерцания" value={options.temporal_smoothing} min={0} max={0.85} step={0.05} onChange={(value) => patchOptions('temporal_smoothing', value)} />

            <button className="primary-button" type="button" disabled={!job || job.status !== 'ready' || uploading} onClick={startProcessing}>
              {isProcessing ? <LoaderCircle className="spin" size={18} /> : <Play size={18} fill="currentColor" />}
              Преобразовать в ASCII · {selectedOutputFormat.toUpperCase()}
            </button>
            <div className="sound-note">{selectedOutputFormat === 'gif' || !options.keep_audio ? <VolumeX size={15} /> : <Volume2 size={15} />} {selectedOutputFormat === 'gif' ? 'GIF будет зациклен и сохранён без звука' : job?.video && !job.video.has_audio ? 'GIF и этот исходник не содержат звука' : options.keep_audio ? 'Звук будет синхронизирован с результатом' : 'Звуковая дорожка будет удалена'}</div>
          </aside>
        </div>

        <div hidden={activeTab !== 'image'}>
          <ImageWorkspace />
        </div>

        <div hidden={activeTab !== 'banner'}>
          <TextBannerWorkspace />
        </div>
      </main>

      <footer><span>ASCII MOTION / LOCAL MEDIA PIPELINE</span><span>VIDEO · GIF · IMAGE · LETTER ART</span></footer>
    </div>
  )
}
