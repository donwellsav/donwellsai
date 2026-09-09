import {
  Folders, Maximize2, Minimize2, File, Folder, FilePlus, FolderPlus, Terminal, GitBranch, Minus, ChevronLeft, ChevronRight, House,
  Ellipsis, ExternalLink, History, BookOpen, PanelRightClose, PanelsTopLeft,
  Command, Monitor, Plus, X, Search, RefreshCw, Settings, Bell, Shield, Square,
  Play, Columns2, Eye, Pencil, Activity, Check, CircleCheck, ChevronUp,
  ChevronDown, CircleHelp, Clock, PanelLeft, PanelRight, Globe, Bot, Zap,
  Smartphone, ChevronsRight, CircleAlert, Rows2, Grid2X2, type LucideIcon
} from 'lucide-react'

// Semantic names keep the same action recognizable across every surface.
const icons: Record<string, LucideIcon> = {
  projects: Folders, maximize: Maximize2, restore: Minimize2, file: File, dir: Folder, filePlus: FilePlus, folderPlus: FolderPlus, terminal: Terminal, git: GitBranch, minus: Minus,
  left: ChevronLeft, right: ChevronRight, home: House, more: Ellipsis,
  external: ExternalLink, history: History, memory: BookOpen, dock: PanelRightClose,
  layout: PanelsTopLeft, command: Command, monitor: Monitor, plus: Plus, x: X,
  search: Search, refresh: RefreshCw, gear: Settings, bell: Bell, shield: Shield,
  stop: Square, play: Play, split: Columns2, eye: Eye, edit: Pencil,
  activity: Activity, check: Check, 'check-circle': CircleCheck, up: ChevronUp,
  down: ChevronDown, columns: Columns2, question: CircleHelp, clock: Clock,
  panelLeft: PanelLeft, panelRight: PanelRight, globe: Globe, robot: Bot,
  bolt: Zap, mobile: Smartphone, chevrons: ChevronsRight, alert: CircleAlert,
  rows: Rows2, grid: Grid2X2
}

export function Icon({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  const Glyph = icons[name] ?? CircleHelp
  return <Glyph className={className} size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />
}
