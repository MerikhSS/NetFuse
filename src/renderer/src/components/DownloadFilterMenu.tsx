import type { DownloadFilter } from '../store/useAppStore'
import { FilterMenu } from './FilterMenu'

const DOWNLOAD_FILTERS: { value: DownloadFilter; label: string }[] = [
  { value: 'all', label: 'All downloads' },
  { value: 'progress', label: 'In progress' },
  { value: 'finished', label: 'Finished' },
  { value: 'failed', label: 'Needs attention' }
]

export function DownloadFilterMenu({
  value,
  counts,
  onChange
}: {
  value: DownloadFilter
  counts: Record<DownloadFilter, number>
  onChange: (value: DownloadFilter) => void
}): React.JSX.Element {
  return (
    <FilterMenu
      options={DOWNLOAD_FILTERS}
      value={value}
      counts={counts}
      onChange={onChange}
      label="Filter downloads"
    />
  )
}
