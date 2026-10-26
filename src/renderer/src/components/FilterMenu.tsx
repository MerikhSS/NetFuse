import { Menu } from '@base-ui/react/menu'
import { Check, ChevronDown } from 'lucide-react'

/** A screen's title that is also its filter: what is shown, and a menu of the other choices with
 * how many each has. */
export function FilterMenu<T extends string>({
  options,
  value,
  counts,
  onChange,
  label
}: {
  options: { value: T; label: string }[]
  value: T
  counts: Record<T, number>
  onChange: (value: T) => void
  /** What the choices filter, for assistive tech. */
  label: string
}): React.JSX.Element {
  const shown = options.find((option) => option.value === value)!.label
  return (
    <Menu.Root>
      <h1>
        <Menu.Trigger className="flex h-8 items-center gap-2 rounded-lg px-2.5 font-sans text-[14px] leading-none font-semibold whitespace-nowrap outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
          {shown}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Menu.Trigger>
      </h1>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={8} className="isolate z-50">
          <Menu.Popup className="w-52 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
            <Menu.RadioGroup
              value={value}
              onValueChange={onChange}
              aria-label={label}
              className="flex flex-col gap-0.5"
            >
              {options.map((option) => (
                <Menu.RadioItem
                  key={option.value}
                  value={option.value}
                  label={option.label}
                  closeOnClick
                  className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] outline-none data-checked:bg-muted data-highlighted:bg-muted"
                >
                  <span className="size-4 shrink-0">
                    <Menu.RadioItemIndicator>
                      <Check aria-hidden className="size-4 text-primary" />
                    </Menu.RadioItemIndicator>
                  </span>
                  <span className="flex-1">{option.label}</span>
                  <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
                    {counts[option.value]}
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
