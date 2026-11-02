/** Inline SVG icons: no icon font, no extra request, and they inherit colour. */

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 24, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SyncIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M20.5 4.2v4.6h-4.6" />
  </Svg>
);

export const ListIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 6.5h16M4 12h16M4 17.5h10" />
  </Svg>
);

export const InboxIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3.5 13.5h4l1.5 2.5h6l1.5-2.5h4" />
    <path d="M5.2 5h13.6l1.7 8.5v4A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-4Z" />
  </Svg>
);

export const ChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 5.5 15.5 12 9 18.5" />
  </Svg>
);

export const ArrowLeft = (props: IconProps) => (
  <Svg {...props}>
    <path d="M19 12H5" />
    <path d="M11 6 5 12l6 6" />
  </Svg>
);

export const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Svg>
);

export const AlertIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 8.5v5" />
    <path d="M12 17h.01" />
    <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </Svg>
);

export const CloudOffIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 3l18 18" />
    <path d="M8.5 7.3A5 5 0 0 1 17 10.4a3.8 3.8 0 0 1 2.5 6.3" />
    <path d="M15.5 18H7a4 4 0 0 1-.9-7.9" />
  </Svg>
);

export const PhoneIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6.3 3.5h3l1.5 3.8-2 1.4a12 12 0 0 0 5.5 5.5l1.4-2 3.8 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.3 5.7a2 2 0 0 1 2-2.2Z" />
  </Svg>
);

export const PlusIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const CloseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const TrashIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 7h16" />
    <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
    <path d="M6.5 7l.8 11.3A1.8 1.8 0 0 0 9.1 20h5.8a1.8 1.8 0 0 0 1.8-1.7L17.5 7" />
  </Svg>
);

export const ClockIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const DownloadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 4v10" />
    <path d="m7.5 10 4.5 4.5L16.5 10" />
    <path d="M4.5 19h15" />
  </Svg>
);
