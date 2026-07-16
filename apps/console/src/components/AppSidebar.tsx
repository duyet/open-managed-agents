import type { ComponentType } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { PlusIcon, MegaphoneIcon } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";

import { TenantSwitcher } from "./TenantSwitcher";
import { Logo } from "./Logo";
import { UserProfile } from "./UserProfile";
import {
  AgentIcon,
  ApiKeysIcon,
  RuntimesIcon,
  DashboardIcon,
  EnvIcon,
  FilesIcon,
  GitHubIcon,
  LinearIcon,
  MemoryIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  SlackIcon,
  VaultIcon,
} from "./icons";
import { consolePlugins } from "../plugins/registry";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/* ── Navigation groups — single source of truth for sidebar items ── */
const navGroups: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Dashboard", icon: DashboardIcon, end: true },
      { to: "/agents", label: "Agents", icon: AgentIcon },
      { to: "/sessions", label: "Sessions", icon: SessionsIcon },
    ],
  },
  {
    label: "Agents",
    items: [
      { to: "/agents/new", label: "New Agent", icon: AgentIcon },
      { to: "/kanban", label: "Kanban Board", icon: SessionsIcon },
    ],
  },
  {
    label: "Publishing",
    items: [{ to: "/my-bots", label: "My Bots", icon: MegaphoneIcon }],
  },
  {
    label: "Infrastructure",
    items: [
      { to: "/environments", label: "Environments", icon: EnvIcon },
      { to: "/runtimes", label: "Sandbox Runtime", icon: RuntimesIcon },
      { to: "/vaults", label: "Credential Vaults", icon: VaultIcon },
      { to: "/model-cards", label: "Model Cards", icon: ModelCardsIcon },
    ],
  },
  {
    label: "Resources",
    items: [
      { to: "/skills", label: "Skills", icon: SkillsIcon },
      { to: "/memory", label: "Memory Stores", icon: MemoryIcon },
      { to: "/files", label: "Files", icon: FilesIcon },
      { to: "/api-keys", label: "API Keys", icon: ApiKeysIcon },
      { to: "/evals", label: "Eval Runs", icon: SessionsIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/integrations/linear", label: "Linear", icon: LinearIcon },
      { to: "/integrations/github", label: "GitHub", icon: GitHubIcon },
      { to: "/integrations/slack", label: "Slack", icon: SlackIcon },
    ],
  },
];


export function AppSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const groups = [
    ...navGroups,
    ...consolePlugins.flatMap((p) => p.navGroups ?? []),
  ];

  const isItemActive = (to: string, end?: boolean) => {
    if (end) return pathname === to;
    return pathname === to || pathname.startsWith(`${to}/`);
  };

  const renderItem = (item: NavItem) => {
    const active = isItemActive(item.to, item.end);
    return (
      <SidebarMenuItem key={item.to}>
        <SidebarMenuButton
          asChild
          isActive={active}
          tooltip={item.label}
          className={
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
              : "!bg-transparent hover:!bg-sidebar-accent/50 !text-sidebar-foreground hover:!text-sidebar-foreground"
          }
        >
          <NavLink to={item.to} end={item.end}>
            <item.icon className="size-4 opacity-80" />
            <span>{item.label}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar border-0 group-data-[side=left]:border-r-0"
    >
      <SidebarHeader className="bg-sidebar h-11 px-3 flex-row items-center gap-2">
        <Logo size="sm" />
        <span className="font-mono font-bold text-base text-brand group-data-[collapsible=icon]:hidden">
          oma
        </span>
      </SidebarHeader>

      <div className="mt-2">
        <TenantSwitcher />
      </div>

      {/* Quick action: New Agent — always visible, gets you started fast */}
      <div className="px-3 pt-3 pb-1 group-data-[collapsible=icon]:hidden">
        <Button
          onClick={() => navigate("/agents/new")}
          className="w-full gap-1.5 text-sm h-9"
          size="sm"
        >
          <PlusIcon className="size-4" />
          New Agent
        </Button>
      </div>

      <SidebarContent className="bg-sidebar [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {groups.map((g) => (
          <SidebarGroup key={g.label}>
            <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
            <SidebarMenu>{g.items.map(renderItem)}</SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="bg-sidebar p-0">
        <UserProfile />
      </SidebarFooter>
    </Sidebar>
  );
}
