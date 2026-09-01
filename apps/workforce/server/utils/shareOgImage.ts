import sharp from 'sharp'
import { cleanShareText, escapeXml, wrapShareText } from './sharePreview'

export type ShareOgKind = 'site' | 'job' | 'candidate' | 'flat'

export type ShareOgCard = {
  kind: ShareOgKind
  title: string
  description?: string
}

const KIND_STYLE: Record<ShareOgKind, { accent: string; accentSoft: string; label: string }> = {
  site: { accent: '#d98cff', accentSoft: '#e0679a', label: 'PORTFOLIO · SERVICES · TOOLS' },
  job: { accent: '#ffb86c', accentSoft: '#e0679a', label: 'JOB FINDER · VACANCY' },
  candidate: { accent: '#67e8f9', accentSoft: '#d98cff', label: 'HIRING BOARD · CANDIDATE' },
  flat: { accent: '#e0679a', accentSoft: '#67e8f9', label: 'FLAT FINDER · LISTING' },
}

function svgText(value: unknown): string {
  return escapeXml(cleanShareText(value, 260).replace(/\p{Cc}+/gu, ''))
}

function textLines(lines: string[], x: number, y: number, lineHeight: number, className: string): string {
  return lines
    .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" class="${className}">${svgText(line)}</text>`)
    .join('')
}

function kindIcon(kind: ShareOgKind, accent: string): string {
  if (kind === 'job') {
    return `<g transform="translate(914 190)" fill="none" stroke="${accent}" stroke-width="12" stroke-linejoin="round">
      <rect x="0" y="38" width="184" height="138" rx="28"/><path d="M58 38V18c0-10 8-18 18-18h32c10 0 18 8 18 18v20M0 92h184M70 92v22h44V92"/>
    </g>`
  }
  if (kind === 'candidate') {
    return `<g transform="translate(936 180)" fill="none" stroke="${accent}" stroke-width="12">
      <circle cx="72" cy="54" r="42"/><path d="M0 184c5-55 34-84 72-84s67 29 72 84" stroke-linecap="round"/>
    </g>`
  }
  if (kind === 'flat') {
    return `<g transform="translate(914 190)" fill="none" stroke="${accent}" stroke-width="12" stroke-linejoin="round" stroke-linecap="round">
      <path d="M0 82 92 4l92 78v100H0Z"/><path d="M60 182v-64h64v64M28 92h128"/>
    </g>`
  }
  return `<g transform="translate(920 184)" fill="none" stroke="${accent}" stroke-width="11" stroke-linecap="round">
    <path d="M92 0v52M92 132v52M0 92h52M132 92h52M27 27l37 37M120 120l37 37M157 27l-37 37M64 120l-37 37"/>
    <circle cx="92" cy="92" r="28" fill="${accent}" fill-opacity=".18"/>
  </g>`
}

export function buildShareOgSvg(card: ShareOgCard): string {
  const style = KIND_STYLE[card.kind]
  const title = cleanShareText(card.title, 150) || 'WhitesLove'
  const description = cleanShareText(card.description, 210)
  const titleLines = wrapShareText(title, 31, 3)
  const descriptionLines = description ? wrapShareText(description, 57, 2) : []

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="ocean" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#04071d"/><stop offset=".52" stop-color="#07133a"/><stop offset="1" stop-color="#18092c"/>
      </linearGradient>
      <radialGradient id="glowA"><stop stop-color="${style.accent}" stop-opacity=".34"/><stop offset="1" stop-color="${style.accent}" stop-opacity="0"/></radialGradient>
      <radialGradient id="glowB"><stop stop-color="${style.accentSoft}" stop-opacity=".28"/><stop offset="1" stop-color="${style.accentSoft}" stop-opacity="0"/></radialGradient>
      <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${style.accent}"/><stop offset=".5" stop-color="${style.accentSoft}"/><stop offset="1" stop-color="#26345d" stop-opacity=".22"/></linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="28"/></filter>
    </defs>
    <rect width="1200" height="630" fill="url(#ocean)"/>
    <ellipse cx="1030" cy="105" rx="340" ry="260" fill="url(#glowA)" filter="url(#blur)"/>
    <ellipse cx="240" cy="620" rx="360" ry="210" fill="url(#glowB)" filter="url(#blur)"/>
    <g fill="none" stroke="#67e8f9" opacity=".32">
      <circle cx="1095" cy="96" r="13" stroke-width="3"/><circle cx="1130" cy="150" r="7" stroke-width="2"/><circle cx="1060" cy="160" r="5" stroke-width="2"/>
      <circle cx="1038" cy="74" r="4" stroke-width="2"/><circle cx="1125" cy="252" r="18" stroke-width="3"/><circle cx="1075" cy="286" r="8" stroke-width="2"/>
      <circle cx="92" cy="500" r="15" stroke-width="3"/><circle cx="142" cy="548" r="7" stroke-width="2"/><circle cx="44" cy="420" r="5" stroke-width="2"/>
    </g>
    <path d="M0 540c128-46 222-31 342 6 118 37 242 42 364-1 137-48 306-38 494 20v65H0Z" fill="#050923" opacity=".86"/>
    <path d="M0 565c147-35 277-17 391 17 118 36 246 29 371-7 132-38 278-31 438 15" fill="none" stroke="#7638a9" stroke-width="3" opacity=".36"/>
    <rect x="52" y="45" width="1096" height="540" rx="38" fill="#070b22" fill-opacity=".84" stroke="url(#edge)" stroke-width="2"/>
    <path d="M53 222V83c0-21 17-38 38-38h252" fill="none" stroke="${style.accent}" stroke-width="3" opacity=".92"/>
    <circle cx="1076" cy="510" r="3" fill="${style.accentSoft}"/><circle cx="1096" cy="478" r="7" fill="none" stroke="${style.accent}" stroke-width="2" opacity=".7"/>
    <style>
      text { font-family: 'DejaVu Sans', 'Arial', sans-serif; }
      .eyebrow { fill: ${style.accent}; font-size: 22px; font-weight: 700; letter-spacing: 2px; }
      .title { fill: #f7f8ff; font-size: 48px; font-weight: 700; }
      .description { fill: #b7bfd8; font-size: 24px; font-weight: 400; }
      .brand { fill: #f7f8ff; font-size: 25px; font-weight: 700; }
      .url { fill: #8f9ab9; font-size: 19px; letter-spacing: 1px; }
    </style>
    <text x="86" y="112" class="eyebrow">${style.label}</text>
    ${textLines(titleLines, 86, 207, 62, 'title')}
    ${textLines(descriptionLines, 86, 424, 36, 'description')}
    <text x="86" y="542" class="url">WHITESLOVE.ME</text>
    <text x="1034" y="542" text-anchor="end" class="brand">WhitesLove</text>
    ${kindIcon(card.kind, style.accent)}
  </svg>`
}

export async function renderShareOgPng(card: ShareOgCard): Promise<Buffer> {
  return sharp(Buffer.from(buildShareOgSvg(card)))
    .png({ compressionLevel: 9 })
    .toBuffer()
}
