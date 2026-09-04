import { CSSProperties, DragEvent, useEffect, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  FileText,
  Hash,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import { mediaStylePresets, MediaStyleKey } from './mediaStyles'

interface ImageJob {
  id: string
  status: 'ready' | 'completed' | 'error'
  message: string | null
  image: { width: number; height: number; format: 'png' | 'jpeg' | 'webp' }
  result_image_url: string | null
  result_text_url: string | null
  source_url: string
}

interface ImageOptions {
  grid_width: number
  target_character_count: number | null
  character_size: number
  contrast: number
  brightness: number
  invert: boolean
  character_color: string
  background_color: string
  character_set: 'console' | 'classic' | 'detailed' | 'minimal' | 'braille'
  mode: 'monochrome' | 'original_colors'
  normalize_contrast: boolean
}

const defaults: ImageOptions = {
  grid_width: 96,
  target_character_count: null,
  character_size: 10,
  contrast: 1.2,
  brightness: 0,
  invert: false,
  character_color: '#e9ecef',
  background_color: '#050607',
  character_set: 'console',
  mode: 'monochrome',
  normalize_contrast: true,
}

function messageFromResponse(response: Response): Promise<string> {
  return response.json()
    .then((body) => body.detail || body.message || `Ошибка ${response.status}`)
    .catch(() => `Ошибка ${response.status}`)
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  disabled = false,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  disabled?: boolean
  onChange: (value: number) => void
}) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className={`range-control ${disabled ? 'disabled' : ''}`}>
      <span>{label}<output>{value}{suffix}</output></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--range-progress': `${progress}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function Toggle({ checked, label, hint, onChange }: { checked: boolean; label: string; hint?: string; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true"><span /></span>
    </label>
  )
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`
}

export default function ImageWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null)
  const sourceUrlRef = useRef<string | null>(null)
  const jobRef = useRef<ImageJob | null>(null)
  const optionsRef = useRef<ImageOptions>(defaults)
  const processingRef = useRef(false)
  const pendingRenderRef = useRef(false)
  const [file, setFile] = useState<File | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteSourceLabel, setRemoteSourceLabel] = useState<string | null>(null)
  const [importingUrl, setImportingUrl] = useState(false)
  const [job, setJob] = useState<ImageJob | null>(null)
  const [options, setOptions] = useState<ImageOptions>(defaults)
  const [textResult, setTextResult] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [maxImageUploadMb, setMaxImageUploadMb] = useState(20)
  const [stylePreset, setStylePreset] = useState<MediaStyleKey | null>('classic')
  const [exactCountEnabled, setExactCountEnabled] = useState(false)
  const [characterCountInput, setCharacterCountInput] = useState('1000')

  jobRef.current = job
  optionsRef.current = options

  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((health) => {
        if (health.limits?.max_image_upload_mb) setMaxImageUploadMb(health.limits.max_image_upload_mb)
      })
      .catch(() => undefined)
    return () => {
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (!job || uploading || importingUrl) return
    setDirty(true)
    const timer = window.setTimeout(() => void processImage(), 420)
    return () => window.clearTimeout(timer)
  }, [job?.id, options, uploading, importingUrl])

  const patchOption = <K extends keyof ImageOptions>(key: K, value: ImageOptions[K]) => {
    if (['grid_width', 'target_character_count', 'character_size', 'contrast', 'brightness', 'invert', 'character_color', 'background_color', 'character_set', 'mode', 'normalize_contrast'].includes(key)) {
      setStylePreset(null)
    }
    setOptions((current) => ({ ...current, [key]: value }))
    if (job?.status === 'completed') setDirty(true)
  }

  const applyStylePreset = (key: MediaStyleKey) => {
    const preset = mediaStylePresets.find((item) => item.key === key)
    if (!preset) return
    setStylePreset(key)
    setOptions((current) => ({ ...current, ...preset.image }))
    if (job?.status === 'completed') setDirty(true)
  }

  const toggleExactCount = (enabled: boolean) => {
    setExactCountEnabled(enabled)
    if (enabled) {
      const parsed = Number(characterCountInput)
      patchOption('target_character_count', Number.isInteger(parsed) && parsed >= 100 && parsed <= 100_000 ? parsed : 1000)
      if (!Number.isInteger(parsed) || parsed < 100 || parsed > 100_000) setCharacterCountInput('1000')
    } else {
      patchOption('target_character_count', null)
    }
  }

  const updateCharacterCount = (value: string) => {
    setCharacterCountInput(value)
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 100_000) {
      patchOption('target_character_count', parsed)
    }
  }

  const normalizeCharacterCount = () => {
    const parsed = Number(characterCountInput)
    const normalized = Number.isFinite(parsed) ? Math.min(100_000, Math.max(100, Math.round(parsed))) : 1000
    setCharacterCountInput(String(normalized))
    patchOption('target_character_count', normalized)
  }

  async function disposeJob() {
    if (!job) return
    try {
      await fetch(`/api/images/${job.id}`, { method: 'DELETE' })
    } catch {
      // Temporary image jobs can also be cleaned by the server administrator.
    }
  }

  async function chooseFile(nextFile?: File) {
    if (!nextFile) return
    const extension = nextFile.name.toLowerCase().slice(nextFile.name.lastIndexOf('.'))
    const allowed = ['.png', '.jpg', '.jpeg', '.webp']
    const validMime = !nextFile.type || ['image/png', 'image/jpeg', 'image/webp'].includes(nextFile.type)
    if (!allowed.includes(extension) || !validMime) {
      setMessage('Выберите изображение PNG, JPG или WebP.')
      return
    }
    if (nextFile.size > maxImageUploadMb * 1024 * 1024) {
      setMessage(`Изображение превышает лимит ${maxImageUploadMb} МБ.`)
      return
    }
    await disposeJob()
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
    const nextSourceUrl = URL.createObjectURL(nextFile)
    sourceUrlRef.current = nextSourceUrl
    setFile(nextFile)
    setSourceUrl(nextSourceUrl)
    setRemoteUrl('')
    setRemoteSourceLabel(null)
    setJob(null)
    setTextResult('')
    setDirty(false)
    setMessage(null)
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', nextFile)
      const response = await fetch('/api/images', { method: 'POST', body: form })
      if (!response.ok) throw new Error(await messageFromResponse(response))
      setJob(await response.json())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить изображение.')
    } finally {
      setUploading(false)
    }
  }

  async function importImageUrl() {
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
      const response = await fetch('/api/images/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      })
      if (!response.ok) throw new Error(await messageFromResponse(response))
      const nextJob: ImageJob = await response.json()
      await disposeJob()
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
      sourceUrlRef.current = null
      const parsed = new URL(value)
      const pathParts = parsed.pathname.split('/').filter(Boolean)
      const pathName = decodeURIComponent(pathParts[pathParts.length - 1] || '')
      setFile(null)
      setSourceUrl(nextJob.source_url)
      setRemoteSourceLabel(pathName || parsed.hostname)
      setJob(nextJob)
      setTextResult('')
      setDirty(false)
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить изображение по ссылке.')
    } finally {
      setImportingUrl(false)
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    void chooseFile(event.dataTransfer.files[0])
  }

  async function processImage() {
    if (!jobRef.current) return
    if (processingRef.current) {
      pendingRenderRef.current = true
      return
    }
    processingRef.current = true
    setProcessing(true)
    setDirty(true)
    setMessage(null)
    setCopied(false)
    try {
      do {
        pendingRenderRef.current = false
        const currentJob: ImageJob | null = jobRef.current
        const currentOptions: ImageOptions = optionsRef.current
        if (!currentJob) break
        const response = await fetch(`/api/images/${currentJob.id}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentOptions),
        })
        if (!response.ok) throw new Error(await messageFromResponse(response))
        const nextJob: ImageJob = await response.json()
        if (jobRef.current?.id !== currentJob.id) break
        if (optionsRef.current !== currentOptions) {
          pendingRenderRef.current = true
          continue
        }
        let nextText: string | null = null
        if (nextJob.result_text_url) {
          const textResponse = await fetch(nextJob.result_text_url, { cache: 'no-store' })
          if (!textResponse.ok) throw new Error(await messageFromResponse(textResponse))
          nextText = await textResponse.text()
        }
        if (optionsRef.current !== currentOptions) {
          pendingRenderRef.current = true
        } else {
          setJob(nextJob)
          if (nextText !== null) setTextResult(nextText)
        }
      } while (pendingRenderRef.current && jobRef.current)
      if (!pendingRenderRef.current) setDirty(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось преобразовать изображение.')
    } finally {
      processingRef.current = false
      setProcessing(false)
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(textResult)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setMessage('Браузер не разрешил доступ к буферу обмена. Скачайте TXT-файл.')
    }
  }

  function reset() {
    void disposeJob()
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current)
    sourceUrlRef.current = null
    setFile(null)
    setSourceUrl(null)
    setRemoteUrl('')
    setRemoteSourceLabel(null)
    setJob(null)
    setTextResult('')
    setMessage(null)
    setDirty(false)
    pendingRenderRef.current = false
    if (inputRef.current) inputRef.current.value = ''
  }

  const imageDownload = job ? `/api/images/${job.id}/result?format=png&download=true` : '#'
  const textDownload = job ? `/api/images/${job.id}/result?format=txt&download=true` : '#'
  const mediaAspect = job ? { '--media-aspect': `${job.image.width} / ${job.image.height}` } as CSSProperties : undefined
  const renderedCharacterCount = textResult.replace(/\r?\n/g, '').length

  return (
    <div className="workspace image-workspace">
      <section className="stage-column" aria-label="Преобразование изображения">
        {!file && !job ? (
          <div
            className={`drop-zone image-drop-zone ${dragging ? 'is-dragging' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="drop-icon"><ImageIcon size={28} strokeWidth={1.7} /></div>
            <h2>Перетащите изображение</h2>
            <p>PNG, JPG или WebP · до {maxImageUploadMb} МБ</p>
            <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>
              <Upload size={17} /> Выбрать изображение
            </button>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
            <div className="or-divider"><span>или</span></div>
            <form className="url-import" onSubmit={(event) => { event.preventDefault(); void importImageUrl() }}>
              <input
                type="url"
                inputMode="url"
                value={remoteUrl}
                placeholder="https://example.com/photo.jpg"
                aria-label="Прямая ссылка на изображение"
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
              <button type="submit" disabled={importingUrl || !remoteUrl.trim()}>
                {importingUrl ? <LoaderCircle className="spin" size={17} /> : <Link2 size={17} />}
                {importingUrl ? 'Импорт…' : 'Добавить URL'}
              </button>
            </form>
            <small className="url-hint">Прямая ссылка на PNG, JPG или WebP</small>
          </div>
        ) : (
          <>
            <div className="file-strip">
              <div className="file-icon"><ImageIcon size={19} /></div>
              <div>
                <strong>{file?.name || remoteSourceLabel || 'Изображение по ссылке'}</strong>
                <span>{file ? formatSize(file.size) : 'Импортировано по URL'}{job ? ` · ${job.image.width}×${job.image.height}` : ''}</span>
              </div>
              <button type="button" onClick={reset} disabled={processing} aria-label="Удалить изображение"><X size={18} /></button>
            </div>

            <div className="media-grid image-media-grid adaptive-media-grid" style={mediaAspect}>
              <article className="media-card">
                <div className="card-label"><span>01</span> Исходник</div>
                {sourceUrl && <img className="source-image" src={sourceUrl} alt="Исходное изображение" />}
              </article>
              <article className="media-card result-card">
                <div className="card-label"><span>02</span> ASCII-изображение{renderedCharacterCount > 0 && <small className="card-meta">{renderedCharacterCount.toLocaleString('ru-RU')} симв.</small>}</div>
                <div className="preview-surface" style={{ backgroundColor: options.background_color }}>
                  {job?.result_image_url
                    ? <img src={job.result_image_url} alt="Результат в виде ASCII-изображения" />
                    : <div className="preview-placeholder"><span>@#S%?*+</span><p>{uploading ? 'Загрузка' : processing ? 'Обновляем результат' : 'Предпросмотр появится автоматически'}</p></div>
                  }
                  {processing && <div className="preview-loader"><LoaderCircle className="spin" size={22} /> Обработка</div>}
                </div>
              </article>
            </div>

            {dirty && <div className="stale-note live-note"><LoaderCircle className="spin" size={15} /> Предпросмотр обновляется автоматически…</div>}

            {job?.status === 'completed' && (
              <div className="image-downloads">
                <a className="download-button" href={imageDownload} download="ascii-image.png"><Download size={18} /> Скачать PNG</a>
                <a className="download-button secondary-download" href={textDownload} download="ascii-image.txt"><FileText size={18} /> Скачать TXT</a>
              </div>
            )}

            {textResult && (
              <section className="text-result">
                <div className="text-result-head">
                  <div><FileText size={17} /><strong>ASCII-текст</strong><span>{options.target_character_count ? `${renderedCharacterCount.toLocaleString('ru-RU')} символов всего` : `${options.grid_width} символов в строке`}</span></div>
                  <button type="button" onClick={copyText}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Скопировано' : 'Копировать'}</button>
                </div>
                <pre>{textResult}</pre>
              </section>
            )}
          </>
        )}

        {message && <div className="message error-message" role="alert">{message}</div>}
      </section>

      <aside className="settings-panel" aria-label="Настройки ASCII-изображения">
        <div className="panel-title"><SlidersHorizontal size={18} /><h2>Настройки изображения</h2><button type="button" onClick={() => { setOptions(defaults); setStylePreset('classic'); setExactCountEnabled(false); setCharacterCountInput('1000'); setDirty(Boolean(job?.result_image_url)) }} title="Сбросить"><RefreshCw size={15} /></button></div>

        <div className="style-section-title">Стиль ASCII</div>
        <div className="style-presets" role="group" aria-label="Стиль ASCII-изображения">
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
          <span><strong>Цвет символов</strong><small>Выберите вид готового изображения</small></span>
        </div>
        <fieldset className="segmented color-mode-segmented">
          <legend>Режим цвета</legend>
          <button type="button" aria-pressed={options.mode === 'monochrome'} className={options.mode === 'monochrome' ? 'active' : ''} onClick={() => patchOption('mode', 'monochrome')}>Чёрно-белое</button>
          <button type="button" aria-pressed={options.mode === 'original_colors'} className={options.mode === 'original_colors' ? 'active' : ''} onClick={() => patchOption('mode', 'original_colors')}>Цветное</button>
        </fieldset>
        <p className={`color-mode-help ${options.mode === 'original_colors' ? 'is-color' : ''}`}>
          <span aria-hidden="true" />
          {options.mode === 'original_colors' ? 'Каждый символ получит цвет соответствующей области исходного изображения.' : 'Все символы будут одного выбранного цвета.'}
        </p>

        <div className="controls-group">
          <div className="exact-count-panel">
            <Toggle checked={exactCountEnabled} onChange={toggleExactCount} label="Точное количество символов" hint="Считаются все ячейки сетки, включая пробелы" />
            {exactCountEnabled && (
              <label className="exact-count-input">
                <Hash size={16} />
                <input type="number" min="100" max="100000" step="1" inputMode="numeric" value={characterCountInput} onChange={(event) => updateCharacterCount(event.target.value)} onBlur={normalizeCharacterCount} aria-label="Количество символов в результате" />
                <span>символов</span>
              </label>
            )}
          </div>
          <RangeControl disabled={exactCountEnabled} label="Ширина сетки" value={options.grid_width} min={32} max={240} onChange={(value) => patchOption('grid_width', value)} />
          <RangeControl label="Размер символа" value={options.character_size} min={8} max={24} suffix=" px" onChange={(value) => patchOption('character_size', value)} />
          <RangeControl label="Контраст" value={options.contrast} min={0.5} max={3} step={0.1} suffix="×" onChange={(value) => patchOption('contrast', value)} />
          <RangeControl label="Яркость" value={options.brightness} min={-100} max={100} onChange={(value) => patchOption('brightness', value)} />
        </div>

        <div className="select-grid image-select-grid">
          <label className="wide-select"><span>Набор символов</span><select value={options.character_set} onChange={(event) => patchOption('character_set', event.target.value as ImageOptions['character_set'])}><option value="console">Console dense</option><option value="classic">Classic</option><option value="detailed">Detailed</option><option value="minimal">Minimal</option><option value="braille">Unicode / Braille 2×4</option></select></label>
        </div>

        {options.mode === 'monochrome' && <div className="color-row"><label><span>Символы</span><input type="color" value={options.character_color} onChange={(event) => patchOption('character_color', event.target.value)} /></label><label><span>Фон</span><input type="color" value={options.background_color} onChange={(event) => patchOption('background_color', event.target.value)} /></label></div>}

        <div className="toggle-group image-toggles">
          <Toggle checked={options.invert} onChange={(value) => patchOption('invert', value)} label="Инверсия яркости" />
          <Toggle checked={options.normalize_contrast} onChange={(value) => patchOption('normalize_contrast', value)} label="Автоконтраст" />
        </div>

        <button className="primary-button" type="button" disabled={!job || uploading || processing} onClick={processImage}>
          {processing ? <LoaderCircle className="spin" size={18} /> : <WandSparkles size={18} />}
          {processing ? 'Обновление…' : 'Обновить сейчас'}
        </button>
        <div className="sound-note"><FileText size={15} /> PNG и TXT обновляются после каждого изменения</div>
      </aside>
    </div>
  )
}
