const PATHS = {
  home: 'M4 10.6 12 4l8 6.6V19a1.5 1.5 0 0 1-1.5 1.5H15v-5.5H9v5.5H5.5A1.5 1.5 0 0 1 4 19z',
  groups: 'M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z',
  bracket: 'M3.5 5H8a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h8.5M3.5 19H8a2 2 0 0 0 2-2v-3a2 2 0 0 1 2-2',
  players: 'M8 7.5a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4.5 20c1.3-3.6 4.1-5.6 7.5-5.6s6.2 2 7.5 5.6',
  trophy: 'M8 4.5h8V9a4 4 0 0 1-8 0zM8 6.5H5.5a2.5 2.5 0 0 0 0 5h2.9M16 6.5h2.5a2.5 2.5 0 0 1 0 5h-2.9M12 13v3.5M9.5 16.5h5V20h-5zM8 20h8',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17M12 7.5V12l3 2',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  moon: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z',
  search: 'M10.5 4.5a6 6 0 1 0 0 12a6 6 0 1 0 0-12M15 15l4.5 4.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  chevDown: 'M6 9.5l6 6 6-6',
  chevRight: 'M9.5 6l6 6-6 6',
  check: 'M5.5 12.5l4 4 9-9',
  sync: 'M4.5 12a7.5 7.5 0 0 1 13-5.1M19.5 12a7.5 7.5 0 0 1-13 5.1M17.5 3.5v3.4h-3.4M6.5 20.5v-3.4h3.4',
  paddle: '',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, stroke = 1.8, class: cls }: { name: IconName; size?: number; stroke?: number; class?: string }) {
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {name === 'paddle' ? (
        <>
          <circle cx="13.5" cy="9.5" r="6.8" fill="currentColor" fill-opacity="0.22" />
          <path d="M9.6 14.6 4.4 19.8" stroke-width="3.4" />
          <circle cx="5.6" cy="5.4" r="2.4" fill="#FF8A3D" stroke="none" />
        </>
      ) : (
        <path d={PATHS[name]} />
      )}
    </svg>
  );
}
