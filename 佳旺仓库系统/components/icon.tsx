import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ children, size = 20, ...props }: IconProps & { children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export function HomeIcon(props: IconProps) { return <Icon {...props}><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></Icon>; }
export function UploadIcon(props: IconProps) { return <Icon {...props}><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></Icon>; }
export function ReviewIcon(props: IconProps) { return <Icon {...props}><path d="m4 15 4 4L20 7"/><path d="M4 7h7"/><path d="M4 11h4"/></Icon>; }
export function CatalogIcon(props: IconProps) { return <Icon {...props}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/><path d="M8 7h8M8 11h8"/></Icon>; }
export function SettingsIcon(props: IconProps) { return <Icon {...props}><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.6 2.6l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.8 1.8 0 0 0-.9-3h-.2a1.8 1.8 0 0 1 0-3.6h.2a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-.9 3Z"/></Icon>; }
export function LogoutIcon(props: IconProps) { return <Icon {...props}><path d="M10 4H5v16h5"/><path d="m14 8 4 4-4 4"/><path d="M18 12H8"/></Icon>; }
export function MenuIcon(props: IconProps) { return <Icon {...props}><path d="M4 6h16M4 12h16M4 18h16"/></Icon>; }
export function CloseIcon(props: IconProps) { return <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>; }
export function SearchIcon(props: IconProps) { return <Icon {...props}><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></Icon>; }
export function DownloadIcon(props: IconProps) { return <Icon {...props}><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></Icon>; }
export function ShieldIcon(props: IconProps) { return <Icon {...props}><path d="M12 3 5 6v5c0 4.5 2.8 8.2 7 10 4.2-1.8 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></Icon>; }
export function SparkIcon(props: IconProps) { return <Icon {...props}><path d="m12 3 1.3 5.7L19 10l-5.7 1.3L12 17l-1.3-5.7L5 10l5.7-1.3z"/><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6z"/></Icon>; }
export function AlertIcon(props: IconProps) { return <Icon {...props}><path d="M12 4 3 20h18z"/><path d="M12 9v5M12 17h.01"/></Icon>; }
export function RefreshIcon(props: IconProps) { return <Icon {...props}><path d="M20 11a8 8 0 0 0-14.7-4L3 10"/><path d="M3 5v5h5"/><path d="M4 13a8 8 0 0 0 14.7 4L21 14"/><path d="M21 19v-5h-5"/></Icon>; }
export function PlusIcon(props: IconProps) { return <Icon {...props}><path d="M12 5v14M5 12h14"/></Icon>; }
export function TrashIcon(props: IconProps) { return <Icon {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></Icon>; }
export function ChevronLeftIcon(props: IconProps) { return <Icon {...props}><path d="m15 18-6-6 6-6"/></Icon>; }
export function ChevronRightIcon(props: IconProps) { return <Icon {...props}><path d="m9 18 6-6-6-6"/></Icon>; }
export function ImageIcon(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></Icon>; }
export function SaveIcon(props: IconProps) { return <Icon {...props}><path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></Icon>; }
export function ArrowLeftIcon(props: IconProps) { return <Icon {...props}><path d="m15 18-6-6 6-6M9 12h11"/></Icon>; }
