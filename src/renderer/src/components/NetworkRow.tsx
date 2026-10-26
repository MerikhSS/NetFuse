import type { NetworkStatus, SpeedUnit } from '@shared/types'
import { useState } from 'react'
import { DANGER, type NetworkVisual } from '../theme'
import type { NetworkGroup } from '../utils/format'
import { describeError, formatBytes, formatSpeedOfLimit, networkActive } from '../utils/format'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useAppStore } from '../store/useAppStore'
import { ColorBadge } from './ColorBadge'
import { NetworkEditPopover } from './NetworkEditPopover'
import { TruncatedText } from './TruncatedText'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface NetworkRowProps {
  group: NetworkGroup
  visual: NetworkVisual
  sharePercent: number
  totalBytes?: number | null
  onSwitch: (enabled: boolean) => void
}

const STATUS_TEXT: Record<Exclude<NetworkStatus, 'on'>, string> = {
  off: 'Off',
  offline: 'Not connected',
  unreachable: 'Can’t reach Steam',
  failed: 'Failed',
  limit: 'Data limit reached'
}

/** What a network that isn't simply on says: here, and in the downloads list's tooltip. */
// eslint-disable-next-line react-refresh/only-export-components -- one wording, shared
export function networkStatusText(status: Exclude<NetworkStatus, 'on'>): string {
  return STATUS_TEXT[status]
}

const rowClass = 'col-span-full grid grid-cols-subgrid items-center gap-3'

function ProgressBar({
  percent,
  color,
  label,
  className
}: {
  percent: number
  color: string
  label: string
  className: string
}): React.JSX.Element {
  return (
    <div
      role="cell"
      className={`w-full overflow-hidden rounded-full border-[0.5px] border-[var(--border-strong)] bg-[var(--track-bg)] ${className}`}
    >
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        className="h-full w-full"
      >
        {/* The indicator includes its empty track. Only its decorative fill changes width. */}
        <div
          aria-hidden="true"
          className="h-full rounded-full transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%`, background: color }}
        />
      </div>
    </div>
  )
}

/** A download's streams: each fetches whole depot chunks from one content server. */
function StreamRows({
  group,
  visual
}: {
  group: NetworkGroup
  visual: NetworkVisual
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  return (
    <>
      {group.streams.map((stream, index) => {
        const active = stream.status === 'downloading'
        const done = stream.status === 'completed'
        const percent = done
          ? 100
          : stream.chunkBytes
            ? Math.min(100, ((stream.chunkReceived ?? 0) / stream.chunkBytes) * 100)
            : 0
        const status = done
          ? 'Done'
          : stream.status === 'paused'
            ? 'Paused'
            : stream.status === 'retrying'
              ? 'Retrying…'
              : 'Idle'
        return (
          <div
            role="row"
            key={stream.id}
            className={`${rowClass} border-[var(--border-subtle)] bg-card py-[6px] font-mono text-[11px] leading-[1.2] ${index === 0 ? 'border-t-[0.5px] pt-[9px]' : ''} ${index === group.streams.length - 1 ? 'border-b-[0.5px] pb-[11px]' : ''}`}
          >
            <div role="cell" className="flex justify-center pl-5">
              <div
                className="size-[5px] rounded-full"
                style={{
                  background: active || done ? visual.solid : 'var(--icon-muted)',
                  opacity: active || done ? 1 : 0.4
                }}
              />
            </div>
            <div role="cell" className="flex min-w-0 items-center gap-[6px]">
              <span className="font-medium whitespace-nowrap text-foreground">
                Stream #{index + 1}
              </span>
              <TruncatedText
                className="min-w-0 text-[9.5px] text-muted-foreground"
                text={stream.host}
              />
              {active && stream.hedge ? (
                <ColorBadge
                  bg={visual.bg}
                  border={visual.border}
                  text={visual.text}
                  className="h-[13px] rounded-[3px] px-[5px] py-px text-[9px] font-semibold tracking-[0.04em]"
                >
                  BACKUP
                </ColorBadge>
              ) : (
                !active && (
                  <span
                    className={`text-[9.5px] ${stream.status === 'retrying' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {status}
                  </span>
                )
              )}
            </div>
            <ProgressBar
              className="h-[5px]"
              label={`Stream #${index + 1} progress`}
              percent={percent}
              color={visual.solid}
            />
            <div
              role="cell"
              className="text-right font-mono text-[11px] leading-none font-medium tabular-nums"
              style={{
                color: done ? visual.text : active ? 'var(--text)' : 'var(--text-tertiary)'
              }}
            >
              {shareOf(stream.bytesDownloaded, group.bytesDownloaded)}
            </div>
            <div
              role="cell"
              className="text-right font-mono text-[11px] leading-none font-medium whitespace-nowrap tabular-nums"
              style={{ color: active ? visual.text : 'var(--text-tertiary)' }}
            >
              {active ? formatSpeed(stream.speedBytesPerSec) : '—'}
            </div>
            <div
              role="cell"
              className="pr-5 text-right font-mono text-[11px] leading-none whitespace-nowrap text-[var(--text-secondary)] tabular-nums"
            >
              {formatBytes(stream.bytesDownloaded)}
            </div>
          </div>
        )
      })}
    </>
  )
}

/** A share as the table shows it: 0% for nothing, <1% for a sliver, never past 100%. */
function shareOf(part: number, whole: number): string {
  if (part <= 0 || whole <= 0) return '0%'
  const percent = Math.min(100, Math.round((part / whole) * 100))
  return percent === 0 ? '<1%' : `${percent}%`
}

/** "8.0 / 10.0 MB/s": a network's speed against the limit set on it, the limit quieter. */
function SpeedOfLimit({
  speed,
  limit,
  unit
}: {
  speed: number
  limit: number
  unit: SpeedUnit
}): React.JSX.Element {
  const [value, max] = formatSpeedOfLimit(speed, limit, unit)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span>
            {value}
            <span className="font-medium text-muted-foreground">
              <span className="sr-only">, limited to {max}</span>
              <span aria-hidden> / {max}</span>
            </span>
          </span>
        }
      />
      <TooltipContent>Limited to {max}</TooltipContent>
    </Tooltip>
  )
}

export function NetworkRow({
  group,
  visual,
  sharePercent,
  totalBytes,
  onSwitch
}: NetworkRowProps): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const speedUnit = useAppStore((store) => store.speedUnit)
  const speedLimit = useAppStore((store) => store.networkPreferences[group.id]?.speedLimit)
  const [expanded, setExpanded] = useState(false)
  const connections = group.streams
  const isActive = networkActive(group)
  const hasError = group.status === 'failed'
  const rounded = Math.round(sharePercent)
  const shareLabel = group.bytesDownloaded === 0 ? '0%' : rounded === 0 ? '<1%' : `${rounded}%`
  return (
    <>
      <div
        role="row"
        className={`${rowClass} border-t-[0.5px] border-[var(--border-subtle)] py-[11px]`}
      >
        <div
          role="cell"
          aria-label={hasError ? 'Error' : isActive ? 'Active' : 'Idle'}
          className="ml-5 size-2 rounded-full"
          style={{
            background: hasError ? DANGER : visual.solid,
            animation: isActive ? 'netfuse-glow 1.8s infinite' : undefined,
            opacity: isActive || hasError ? 1 : 0.65
          }}
        />
        <div role="cell" className="flex min-w-0 items-center gap-[6px]">
          <Checkbox
            checked={group.enabled}
            onCheckedChange={(checked) => onSwitch(checked)}
            aria-label={`Use ${visual.name}`}
            className="shrink-0 data-checked:border-transparent"
            style={group.enabled ? { background: visual.solid, color: visual.onSolid } : undefined}
          />
          <TruncatedText
            text={visual.name}
            className={`font-sans text-[12.5px] leading-[1.2] font-semibold ${group.enabled ? 'text-foreground' : 'text-[var(--text-secondary)]'}`}
          />
          <NetworkEditPopover
            interfaceId={group.id}
            interfaceKind={group.kind}
            osName={group.label}
          />
          {connections.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="h-auto cursor-default rounded-[4px] border-[0.5px] bg-card px-[7px] py-[3px] font-mono text-[10.5px] leading-none font-medium text-[var(--text-secondary)] aria-expanded:bg-secondary dark:bg-card"
            >
              {connections.length} stream
              {connections.length === 1 ? '' : 's'}{' '}
              <span aria-hidden className="text-[7.5px] opacity-75">
                {expanded ? '▲' : '▼'}
              </span>
            </Button>
          )}
          {group.status !== 'on' && (
            <Tooltip disabled={!group.error}>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={group.error ? 0 : undefined}
                    className={`rounded-sm font-mono text-[10px] whitespace-nowrap outline-none ${hasError ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {networkStatusText(group.status)}
                  </span>
                }
              />
              <TooltipContent>{group.error && describeError(group.error)}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <ProgressBar
          className="h-1.5"
          label={`${visual.name} progress`}
          percent={
            totalBytes && totalBytes > 0
              ? Math.min(100, (group.bytesDownloaded / totalBytes) * 100)
              : 0
          }
          color={visual.solid}
        />
        <div
          role="cell"
          className="text-right font-mono text-[11.5px] leading-none font-medium tabular-nums"
          style={{ color: sharePercent > 0 ? 'var(--text)' : 'var(--text-tertiary)' }}
        >
          {shareLabel}
        </div>
        <div
          role="cell"
          className="text-right font-mono text-[11px] leading-[1.35] font-semibold whitespace-nowrap tabular-nums"
          style={{ color: isActive ? visual.text : 'var(--text-tertiary)' }}
        >
          <span className="sr-only">Downloading at </span>
          {speedLimit === undefined ? (
            isActive ? (
              formatSpeed(group.speedBytesPerSec)
            ) : (
              '—'
            )
          ) : (
            <SpeedOfLimit
              speed={isActive ? group.speedBytesPerSec : 0}
              limit={speedLimit}
              unit={speedUnit}
            />
          )}
        </div>
        <div
          role="cell"
          className="pr-5 text-right font-mono text-[11.5px] leading-[1.35] text-[var(--text-secondary)] tabular-nums"
        >
          <span className="sr-only">Downloaded </span>
          {formatBytes(group.bytesDownloaded)}
        </div>
      </div>
      {expanded && <StreamRows group={group} visual={visual} />}
    </>
  )
}
