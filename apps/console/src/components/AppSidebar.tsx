import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { PlusIcon, MegaphoneIcon, ChevronRightIcon } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  /** Sub-destinations nested under this item, revealed via a chevron toggle
   *  next to the (still directly clickable) parent link. */
  children?: NavItem[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
  /** Collapsed by default (expands automatically when the active route
   *  lives inside it) so the sidebar shows fewer items at rest. Omit for
   *  groups that should always stay expanded. */
  collapsible?: boolean;
}

/* ── Navigation groups — single source of truth for sidebar items ──
 * Kept to four groups so the sidebar reads as a small set of
 * destinations at rest: a flat "Workspace" core plus three collapsible
 * groups binding related pages together. Every page that used to have
 * its own top-level nav entry is still reachable — just nested one
 * click deeper via a group or item chevron. */
const navGroups: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Dashboard", icon: DashboardIcon, end: true },
      {
        to: "/agents",
        label: "Agents",
        icon: AgentIcon,
        children: [
          { to: "/agents/new", label: "New Agent", icon: AgentIcon },
          { to: "/kanban", label: "Kanban Board", icon: SessionsIcon },
        ],
      },
      { to: "/sessions", label: "Sessions", icon: SessionsIcon },
    ],
  },
  {
    label: "Build & Resources",
    collapsible: true,
    items: [
      { to: "/environments", label: "Environments", icon: EnvIcon },
      { to: "/vaults", label: "Credential Vaults", icon: VaultIcon },
      { to: "/memory", label: "Memory Stores", icon: MemoryIcon },
      { to: "/skills", label: "Skills", icon: SkillsIcon },
      { to: "/files", label: "Files", icon: FilesIcon },
      { to: "/model-cards", label: "Model Cards", icon: ModelCardsIcon },
    ],
  },
  {
    label: "Publishing",
    collapsible: true,
    items: [
      { to: "/my-bots", label: "My Bots", icon: MegaphoneIcon },
      { to: "/integrations/linear", label: "Linear", icon: LinearIcon },
      { to: "/integrations/github", label: "GitHub", icon: GitHubIcon },
      { to: "/integrations/slack", label: "Slack", icon: SlackIcon },
    ],
  },
  {
    label: "Settings & Infra",
    collapsible: true,
    items: [
      { to: "/api-keys", label: "API Keys", icon: ApiKeysIcon },
      { to: "/runtimes", label: "Sandbox Runtime", icon: RuntimesIcon },
      { to: "/evals", label: "Eval Runs", icon: SessionsIcon },
    ],
  },
];

export function AppSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const isItemActive = (to: string, end?: boolean) => {
    if (end) return pathname === to;
    return pathname === to || pathname.startsWith(`${to}/`);
  };

  const itemHasActiveChild = (item: NavItem) =>
    item.children?.some((c) => isItemActive(c.to, c.end)) ?? false;

  const groupHasActiveItem = (group: NavGroup) =>
    group.items.some((item) => isItemActive(item.to, item.end) || itemHasActiveChild(item));

  // Collapsible groups/items default open when the current route lives
  // inside them, collapsed otherwise. A pathname-driven effect re-expands
  // whichever one contains the active route on navigation (e.g. a deep
  // link) without re-collapsing anything the user opened by hand.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      navGroups.filter((g) => g.collapsible).map((g) => [g.label, groupHasActiveItem(g)]),
    ),
  );
  const [openItems, setOpenItems] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      navGroups
        .flatMap((g) => g.items)
        .filter((item) => item.children)
        .map((item) => [item.to, itemHasActiveChild(item)]),
    ),
  );

  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      for (const g of navGroups) {
        if (g.collapsible && groupHasActiveItem(g)) next[g.label] = true;
      }
      return next;
    });
    setOpenItems((prev) => {
      const next = { ...prev };
      for (const item of navGroups.flatMap((g) => g.items)) {
        if (item.children && itemHasActiveChild(item)) next[item.to] = true;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const groups = [
    ...navGroups,
    ...consolePlugins.flatMap((p) => p.navGroups ?? []),
  ];

  const renderItem = (item: NavItem) => {
    const active = isItemActive(item.to, item.end);
    const hasChildren = !!item.children?.length;

    const button = (
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
    );

    if (!hasChildren) {
      return <SidebarMenuItem key={item.to}>{button}</SidebarMenuItem>;
    }

    const isOpen = openItems[item.to] ?? false;

    return (
      <Collapsible
        key={item.to}
        open={isOpen}
        onOpenChange={(open) => setOpenItems((prev) => ({ ...prev, [item.to]: open }))}
        className="group"
      >
        <SidebarMenuItem>
          {button}
          <CollapsibleTrigger asChild>
            <SidebarMenuAction>
              <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" />
              <span className="sr-only">Toggle {item.label} submenu</span>
            </SidebarMenuAction>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              {item.children!.map((child) => {
                const childActive = isItemActive(child.to, child.end);
                return (
                  <SidebarMenuSubItem key={child.to}>
                    <SidebarMenuSubButton asChild isActive={childActive}>
                      <NavLink to={child.to} end={child.end}>
                        <child.icon className="size-4 opacity-80" />
                        <span>{child.label}</span>
                      </NavLink>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                );
              })}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  };

  const renderGroup = (g: NavGroup) => {
    if (!g.collapsible) {
      return (
        <SidebarGroup key={g.label}>
          <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
          <SidebarMenu>{g.items.map(renderItem)}</SidebarMenu>
        </SidebarGroup>
      );
    }

    const isOpen = openGroups[g.label] ?? false;

    return (
      <Collapsible
        key={g.label}
        open={isOpen}
        onOpenChange={(open) => setOpenGroups((prev) => ({ ...prev, [g.label]: open }))}
        className="group"
      >
        <SidebarGroup>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-full shrink-0 items-center justify-between rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-hidden transition-[margin,opacity] duration-200 ease-linear hover:text-sidebar-foreground group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <span>{g.label}</span>
              <ChevronRightIcon className="size-3.5 opacity-60 transition-transform group-data-[state=open]:rotate-90" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenu>{g.items.map(renderItem)}</SidebarMenu>
          </CollapsibleContent>
        </SidebarGroup>
      </Collapsible>
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
        {groups.map(renderGroup)}
      </SidebarContent>

      <SidebarFooter className="bg-sidebar p-0">
        <UserProfile />
      </SidebarFooter>
    </Sidebar>
  );
}
