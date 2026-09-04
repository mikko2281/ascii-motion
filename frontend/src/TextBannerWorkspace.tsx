import { CSSProperties, useMemo, useState } from 'react'
import { Check, Copy, Download, FileText, Type, WandSparkles } from 'lucide-react'

type BannerStyle = 'standard' | 'slant' | 'big' | 'shadow' | '3d'
type BannerPalette = 'classic' | 'dense' | 'minimal'

const bannerStyles: { key: BannerStyle; title: string; sample: string }[] = [
  { key: 'standard', title: 'Standard', sample: 'ASCII' },
  { key: 'slant', title: 'Slant', sample: '/ASCII/' },
  { key: 'big', title: 'Big', sample: 'BIG' },
  { key: 'shadow', title: 'Shadow', sample: '▒ASCII' },
  { key: '3d', title: '3D', sample: '▰ASCII' },
]

const palettes: Record<BannerPalette, string> = {
  classic: ' .:-=+*#%@',
  dense: ' .,:;irsXA253hMHGS#9B&@',
  minimal: ' .:*#@',
}

function bannerFont(style: BannerStyle): { font: string; size: number; lineHeight: number } {
  if (style === 'slant') return { font: 'italic 800 132px Consolas, monospace', size: 132, lineHeight: 150 }
  if (style === 'big') return { font: '900 172px Arial, sans-serif', size: 172, lineHeight: 184 }
  return { font: '800 126px Consolas, monospace', size: 126, lineHeight: 146 }
}

function renderAsciiBanner(text: string, style: BannerStyle, columns: number, paletteKey: BannerPalette): string {
  const sourceLines = (text.trim() || 'ASCII MOTION').split(/\r?\n/).slice(0, 3)
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')
  if (!measure) return text
  const spec = bannerFont(style)
  measure.font = spec.font
  const widest = Math.max(...sourceLines.map((line) => measure.measureText(line || ' ').width))
  const effectRoom = style === '3d' ? 28 : style === 'shadow' ? 20 : 0
  canvas.width = Math.max(360, Math.ceil(widest + 80 + effectRoom))
  canvas.height = Math.ceil(sourceLines.length * spec.lineHeight + 58 + effectRoom)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return text
  context.fillStyle = '#000'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.font = spec.font
  context.textBaseline = 'alphabetic'

  sourceLines.forEach((line, index) => {
    const x = 34
    const y = 28 + spec.size + index * spec.lineHeight
    if (style === 'shadow') {
      context.fillStyle = '#737373'
      context.fillText(line, x + 14, y + 14)
    }
    if (style === '3d') {
      for (let depth = 18; depth >= 2; depth -= 2) {
        const shade = Math.max(55, 145 - depth * 4)
        context.fillStyle = `rgb(${shade},${shade},${shade})`
        context.fillText(line, x + depth, y + depth)
      }
    }
    context.fillStyle = '#fff'
    context.fillText(line, x, y)
  })

  const image = context.getImageData(0, 0, canvas.width, canvas.height).data
  const rows = Math.max(5, Math.ceil((canvas.height / canvas.width) * columns * 0.48))
  const cellWidth = canvas.width / columns
  const cellHeight = canvas.height / rows
  const palette = palettes[paletteKey]
  const output: string[] = []

  for (let row = 0; row < rows; row += 1) {
    let outputLine = ''
    for (let column = 0; column < columns; column += 1) {
      const startX = Math.floor(column * cellWidth)
      const endX = Math.max(startX + 1, Math.floor((column + 1) * cellWidth))
      const startY = Math.floor(row * cellHeight)
      const endY = Math.max(startY + 1, Math.floor((row + 1) * cellHeight))
      let brightness = 0
      let samples = 0
      const xStep = Math.max(1, Math.floor((endX - startX) / 3))
      const yStep = Math.max(1, Math.floor((endY - startY) / 3))
      for (let y = startY; y < Math.min(endY, canvas.height); y += yStep) {
        for (let x = startX; x < Math.min(endX, canvas.width); x += xStep) {
          brightness += image[(y * canvas.width + x) * 4]
          samples += 1
        }
      }
      const normalized = samples ? brightness / samples / 255 : 0
      outputLine += palette[Math.round(normalized * (palette.length - 1))]
    }
    output.push(outputLine.replace(/\s+$/, ''))
  }

  while (output.length && !output[0].trim()) output.shift()
  while (output.length && !output[output.length - 1].trim()) output.pop()
  return output.join('\n') || text
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function TextBannerWorkspace() {
  const [text, setText] = useState('ASCII MOTION')
  const [style, setStyle] = useState<BannerStyle>('standard')
  const [palette, setPalette] = useState<BannerPalette>('classic')
  const [columns, setColumns] = useState(88)
  const [foreground, setForeground] = useState('#c8ff3d')
  const [background, setBackground] = useState('#050607')
  const [copied, setCopied] = useState(false)
  const result = useMemo(() => renderAsciiBanner(text, style, columns, palette), [text, style, columns, palette])

  async function copyResult() {
    await navigator.clipboard.writeText(result)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  function downloadText() {
    downloadBlob(new Blob([result], { type: 'text/plain;charset=utf-8' }), 'ascii-banner.txt')
  }

  function downloadPng() {
    const lines = result.split('\n')
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return
    const fontSize = 14
    const lineHeight = 16
    context.font = `${fontSize}px Consolas, monospace`
    const maxWidth = Math.max(...lines.map((line) => context.measureText(line || ' ').width))
    const padding = 28
    canvas.width = Math.ceil(maxWidth + padding * 2)
    canvas.height = Math.max(100, lines.length * lineHeight + padding * 2)
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = foreground
    context.font = `${fontSize}px Consolas, monospace`
    context.textBaseline = 'top'
    lines.forEach((line, index) => context.fillText(line, padding, padding + index * lineHeight))
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, 'ascii-banner.png')
    }, 'image/png')
  }

  const rangeProgress = ((columns - 40) / 100) * 100

  return (
    <div className="workspace banner-workspace">
      <section className="stage-column" aria-label="Предпросмотр текстового баннера">
        <div className="banner-result">
          <div className="card-label"><span>TXT</span> Letter Art / FIGlet</div>
          <pre style={{ color: foreground, backgroundColor: background }}>{result}</pre>
        </div>
        <div className="banner-actions">
          <button className="download-button secondary-download" type="button" onClick={copyResult}>{copied ? <Check size={18} /> : <Copy size={18} />}{copied ? 'Скопировано' : 'Копировать текст'}</button>
          <button className="download-button secondary-download" type="button" onClick={downloadText}><FileText size={18} /> Скачать TXT</button>
          <button className="download-button" type="button" onClick={downloadPng}><Download size={18} /> Скачать PNG</button>
        </div>
      </section>

      <aside className="settings-panel" aria-label="Настройки текстового баннера">
        <div className="panel-title"><WandSparkles size={18} /><h2>Текстовый баннер</h2></div>
        <label className="banner-text-field">
          <span>Слово или фраза</span>
          <textarea maxLength={120} rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="Введите текст" />
        </label>

        <div className="banner-section-title"><Type size={16} /> Стиль букв</div>
        <div className="banner-style-grid">
          {bannerStyles.map((item) => (
            <button key={item.key} type="button" aria-pressed={style === item.key} className={style === item.key ? 'active' : ''} onClick={() => setStyle(item.key)}>
              <span>{item.sample}</span><strong>{item.title}</strong>
            </button>
          ))}
        </div>

        <label className="range-control banner-range">
          <span>Ширина баннера<output>{columns}</output></span>
          <input type="range" min="40" max="140" value={columns} style={{ '--range-progress': `${rangeProgress}%` } as CSSProperties} onChange={(event) => setColumns(Number(event.target.value))} />
        </label>

        <label className="banner-select"><span>Плотность символов</span><select value={palette} onChange={(event) => setPalette(event.target.value as BannerPalette)}><option value="classic">Классическая</option><option value="dense">Детальная</option><option value="minimal">Минимальная</option></select></label>
        <div className="color-row banner-colors"><label><span>Текст</span><input type="color" value={foreground} onChange={(event) => setForeground(event.target.value)} /></label><label><span>Фон</span><input type="color" value={background} onChange={(event) => setBackground(event.target.value)} /></label></div>
      </aside>
    </div>
  )
}
