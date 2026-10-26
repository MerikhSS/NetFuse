import { cn } from 'cn'

// NetFuse's mark, as its app icon draws it (build/icon.svg): lines from below, one per network,
// all running into one star, white on black. Drawn here rather than loaded, so it is sharp at any
// size and there before anything else has loaded.

const BASES = [222, 367, 512, 657, 802]

export function Logo({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="64 64 896 896"
      role="img"
      aria-label="NetFuse"
      className={cn('size-20', className)}
    >
      <rect x="64" y="64" width="896" height="896" rx="200" fill="#000" />
      <rect
        x="66"
        y="66"
        width="892"
        height="892"
        rx="198"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.12"
        strokeWidth="4"
      />
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="24">
        {BASES.map((x) => (
          <path key={x} d={`M${x} 858 L512 362`} />
        ))}
      </g>
      <g fill="#fff">
        {BASES.map((x) => (
          <circle key={x} cx={x} cy="858" r="30" />
        ))}
      </g>
      <path
        fill="#fff"
        d="M512 150 Q534 338 714 362 Q534 386 512 574 Q490 386 310 362 Q490 338 512 150 Z"
      />
    </svg>
  )
}
