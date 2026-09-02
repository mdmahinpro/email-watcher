import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  Settings,
  Users,
  Inbox,
  Menu,
  Globe,
  Archive,
  LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Logo } from "@/components/logo";
import { useAuth } from "@/hooks/use-auth";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: Activity },
  // Keyword triage queue.
  { href: "/messages", label: "Messages", icon: Inbox },
  // Unfiltered archive from Hostinger mailboxes.
  { href: "/inbox", label: "Hostinger Inbox", icon: Archive },
  { href: "/accounts", label: "Accounts", icon: Users },
  { href: "/hostinger", label: "Hostinger", icon: Globe },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { signOut } = useAuth();

  const SignOutButton = ({ onDone }: { onDone?: () => void }) => (
    <Button
      variant="ghost"
      className="w-full justify-start rounded-xl px-4 text-sm font-medium text-sidebar-foreground/70 active:bg-white/10 md:hover:bg-white/5 md:hover:text-sidebar-foreground"
      onClick={() => {
        onDone?.();
        void signOut();
      }}
    >
      <LogOut className="mr-3 h-4 w-4 shrink-0" />
      Sign out
    </Button>
  );

  const NavLinks = ({ onClick }: { onClick?: () => void }) => (
    <div className="flex flex-col gap-1.5 w-full">
      {NAV_ITEMS.map((item) => {
        const isActive = location === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClick}
            aria-current={isActive ? "page" : undefined}
            // min-h-11 keeps every nav row a comfortable 44px tap target.
            className={`flex min-h-11 items-center gap-3 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all duration-150 ${
              isActive
                ? "bg-sidebar-accent/80 text-sidebar-accent-foreground border-white/10 shadow-[0_0_22px_-6px_rgba(230,20,40,0.5),inset_0_1px_0_rgba(255,255,255,0.08)]"
                : "text-sidebar-foreground/70 active:bg-white/10 md:hover:bg-white/5 md:hover:text-sidebar-foreground border-transparent"
            }`}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </div>
  );

  return (
    // min-h-dvh, not min-h-screen: 100vh on mobile is measured against the
    // toolbar-collapsed viewport and creates a phantom scroll on short pages.
    <div className="flex min-h-dvh w-full flex-col bg-background md:flex-row">
      {/* Mobile Header */}
      <header className="md:hidden sticky top-0 z-40 flex h-14 items-center justify-between border-b border-white/10 bg-background/80 px-4 backdrop-blur-xl">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 font-bold tracking-tight text-foreground"
        >
          <Logo className="h-7 w-7 shrink-0" title={null} />
          <span className="truncate">Email Watcher</span>
        </Link>
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation menu"
              className="-mr-2 shrink-0"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[min(17rem,85vw)] border-white/10 bg-background p-0"
          >
            <div className="border-b border-border p-5 pr-14">
              <Link
                href="/"
                onClick={() => setMobileNavOpen(false)}
                className="flex min-w-0 items-center gap-2.5 text-lg font-bold tracking-tight"
              >
                <Logo className="h-8 w-8 shrink-0" title={null} />
                <span className="truncate">Email Watcher</span>
              </Link>
            </div>
            <nav className="p-3">
              {/* Closing on navigate: the sheet is a modal overlay, so leaving it
                  open would hide the page the user just navigated to. */}
              <NavLinks onClick={() => setMobileNavOpen(false)} />
              <div className="mt-3 border-t border-white/10 pt-3">
                <SignOutButton onDone={() => setMobileNavOpen(false)} />
              </div>
            </nav>
          </SheetContent>
        </Sheet>
      </header>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-[240px] shrink-0 bg-white/[0.02] backdrop-blur-xl border-r border-white/10">
        <div className="px-5 h-16 flex items-center border-b border-white/10">
          <Link href="/" className="flex items-center gap-2.5 font-bold tracking-tight text-lg">
            <Logo
              className="h-9 w-9 shrink-0 shadow-[0_6px_18px_-6px_rgba(230,20,40,0.6)] rounded-[9px]"
              title={null}
            />
            <span>Email Watcher</span>
          </Link>
        </div>
        <nav className="flex-1 px-3 py-4">
          <NavLinks />
        </nav>
        <div className="border-t border-white/10 px-3 py-3">
          <SignOutButton />
        </div>
        <div className="px-4 py-3 border-t border-white/10">
          <p className="text-xs text-muted-foreground text-center">
            Email Watcher v1.0
          </p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
