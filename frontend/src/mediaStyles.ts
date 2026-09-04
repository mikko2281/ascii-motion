export type MediaStyleKey = 'classic' | 'color' | 'tiny' | 'detailed' | 'braille'

export interface MediaStylePreset {
  key: MediaStyleKey
  title: string
  description: string
  sample: string
  video: {
    mode: 'monochrome' | 'original_colors'
    grid_width: number
    character_size: number
    contrast: number
    character_set: 'console' | 'classic' | 'detailed' | 'minimal' | 'braille'
    normalize_contrast: boolean
    temporal_smoothing: number
    quality: 'draft' | 'balanced' | 'high'
  }
  image: {
    mode: 'monochrome' | 'original_colors'
    grid_width: number
    character_size: number
    contrast: number
    character_set: 'console' | 'classic' | 'detailed' | 'minimal' | 'braille'
    normalize_contrast: boolean
  }
}

export const mediaStylePresets: MediaStylePreset[] = [
  {
    key: 'classic',
    title: 'Классика',
    description: 'Свет и тень через плотность символов',
    sample: '.:-=*#@',
    video: { mode: 'monochrome', grid_width: 96, character_size: 10, contrast: 1.2, character_set: 'console', normalize_contrast: true, temporal_smoothing: 0.2, quality: 'balanced' },
    image: { mode: 'monochrome', grid_width: 96, character_size: 10, contrast: 1.2, character_set: 'console', normalize_contrast: true },
  },
  {
    key: 'color',
    title: 'Цветной ASCII',
    description: 'Цвет каждого символа берётся из кадра',
    sample: '●●●●●',
    video: { mode: 'original_colors', grid_width: 112, character_size: 9, contrast: 1.15, character_set: 'console', normalize_contrast: true, temporal_smoothing: 0.2, quality: 'balanced' },
    image: { mode: 'original_colors', grid_width: 112, character_size: 9, contrast: 1.15, character_set: 'console', normalize_contrast: true },
  },
  {
    key: 'tiny',
    title: 'Микро-арт',
    description: 'Компактный силуэт из малого набора знаков',
    sample: '=^.^=',
    video: { mode: 'monochrome', grid_width: 48, character_size: 14, contrast: 1.35, character_set: 'minimal', normalize_contrast: true, temporal_smoothing: 0.35, quality: 'balanced' },
    image: { mode: 'monochrome', grid_width: 48, character_size: 14, contrast: 1.35, character_set: 'minimal', normalize_contrast: true },
  },
  {
    key: 'detailed',
    title: 'Полотно',
    description: 'Максимум деталей, света и глубины',
    sample: 'MWNXK0O',
    video: { mode: 'original_colors', grid_width: 180, character_size: 8, contrast: 1.25, character_set: 'detailed', normalize_contrast: true, temporal_smoothing: 0.15, quality: 'high' },
    image: { mode: 'original_colors', grid_width: 220, character_size: 8, contrast: 1.25, character_set: 'detailed', normalize_contrast: true },
  },
  {
    key: 'braille',
    title: 'Unicode / Braille',
    description: 'Точки 2×4 складываются в символы ⠀–⣿',
    sample: '⣿⣷⣶⣤⣀',
    video: { mode: 'monochrome', grid_width: 110, character_size: 10, contrast: 1.35, character_set: 'braille', normalize_contrast: true, temporal_smoothing: 0.2, quality: 'high' },
    image: { mode: 'monochrome', grid_width: 120, character_size: 10, contrast: 1.35, character_set: 'braille', normalize_contrast: true },
  },
]
