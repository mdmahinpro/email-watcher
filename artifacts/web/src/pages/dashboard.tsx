import type { ComponentType, SVGProps } from "react";
import {
  useGetStatsSummary,
  getGetStatsSummaryQueryKey,
  useListMessages,
  getListMessagesQueryKey,
  useGetKeywordBreakdown,
  getGetKeywordBreakdownQueryKey,
  useGetAccountActivity,
  getGetAccountActivityQueryKey,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import {
  Activity,
  Inbox,
  Mail,
  ArrowRight,
  TrendingUp,
  CalendarRange,
  AlertCircle,
  Archive,
  HardDrive,
  HeartPulse,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend } from "recharts";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, LabelList } from "recharts";
import { useIsMobile } from "@/hooks/use-mobile";

const COLORS = [
  "hsl(356, 100%, 50%)",
  "hsl(199, 89%, 48%)",
  "hsl(38, 92%, 50%)",
  "hsl(262, 83%, 58%)",
  "hsl(142, 76%, 36%)",
];

/**
 * The backend scans on its own schedule, so the dashboard polls to stay current
 * without needing a manual reload. Kept well below the 30s minimum poll interval
 * so a completed scan shows up promptly.
 */
const REFETCH_INTERVAL_MS = 20_000;

const RECENT_MESSAGE_LIMIT = 5;
const recentMessagesParams = { limit: RECENT_MESSAGE_LIMIT } as const;

/** Free-tier database ceilings, for the storage warning. Supabase free is 500 MB. */
const FREE_DB_BYTES = 500 * 1024 * 1024;
/** Warn once the database passes this share of the free ceiling. */
const DB_WARN_RATIO = 0.8;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Dashboard() {
  // Charts get value labels instead of hover tooltips on touch, where there is
  // no pointer and a recharts tooltip can never be opened.
  const isMobile = useIsMobile();

  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    error: statsErrorDetail,
  } = useGetStatsSummary({
    query: {
      queryKey: getGetStatsSummaryQueryKey(),
      refetchInterval: REFETCH_INTERVAL_MS,
    },
  });

  const { data: recentMessages, isLoading: messagesLoading } = useListMessages(
    recentMessagesParams,
    {
      query: {
        queryKey: getListMessagesQueryKey(recentMessagesParams),
        refetchInterval: REFETCH_INTERVAL_MS,
      },
    }
  );
  const recentMessagesList = recentMessages ?? [];

  const { data: keywordBreakdown, isLoading: keywordsLoading } = useGetKeywordBreakdown({
    query: {
      queryKey: getGetKeywordBreakdownQueryKey(),
      refetchInterval: REFETCH_INTERVAL_MS,
    },
  });

  // Cap the slices so the legend cannot outgrow the chart box on a phone.
  const keywordBreakdownList = (keywordBreakdown ?? []).slice(0, isMobile ? 5 : 8);

  const { data: accountActivity, isLoading: activityLoading } = useGetAccountActivity({
    query: {
      queryKey: getGetAccountActivityQueryKey(),
      refetchInterval: REFETCH_INTERVAL_MS,
    },
  });
  const accountActivityList = accountActivity ?? [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 sm:space-y-8">
      {/* Header */}
      <div>
        <h1 className="pin-section-title">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Overview of your email monitoring activity, refreshed automatically.
        </p>
        {/* The heartbeat is the visible proof that the daily database write is
            happening — the thing that keeps a free-tier database from being
            paused for inactivity. */}
        {stats?.heartbeatDay || stats?.databaseBytes != null ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {stats.heartbeatDay ? (
              <span className="inline-flex items-center gap-1.5">
                <HeartPulse className="h-3.5 w-3.5 text-green-400" />
                Database beat: {stats.heartbeatDay}
              </span>
            ) : null}
            {stats.databaseBytes != null ? (
              <span className="inline-flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5" />
                {formatBytes(stats.databaseBytes)} used
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {statsError ? (
        <div className="pin-card flex items-start gap-3 border border-destructive/30 p-4 sm:p-6">
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Could not load statistics
            </h3>
            <p className="pin-break mt-1 text-sm text-muted-foreground">
              {statsErrorDetail?.message ?? "The API server did not respond."}
            </p>
          </div>
        </div>
      ) : null}

      {/* Storage warning: a full free-tier database silently stops accepting new
          mail, so surface it well before that point. */}
      {stats?.databaseBytes != null &&
      stats.databaseBytes > FREE_DB_BYTES * DB_WARN_RATIO ? (
        <div className="pin-card flex items-start gap-3 border border-yellow-500/30 p-4 sm:p-6">
          <HardDrive className="h-5 w-5 shrink-0 text-yellow-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">
              Database is {formatBytes(stats.databaseBytes)}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              That is past {Math.round(DB_WARN_RATIO * 100)}% of a 500 MB free
              tier. Set a retention window in{" "}
              <Link
                href="/settings"
                className="text-sidebar-primary hover:underline"
              >
                Settings
              </Link>{" "}
              to reclaim space before inserts start failing.
            </p>
          </div>
        </div>
      ) : null}

      {/* Stat Cards — 2-up on mobile so they do not push the charts off-screen. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          title="Total Matches"
          value={stats?.totalMatches}
          loading={statsLoading}
          icon={Inbox}
        />
        <StatCard
          title="Last 24 Hours"
          value={stats?.matchesLast24h}
          loading={statsLoading}
          icon={Activity}
        />
        <StatCard
          title="Last 7 Days"
          value={stats?.matchesLast7d}
          loading={statsLoading}
          icon={CalendarRange}
        />
        <StatCard
          title="Active Accounts"
          value={
            stats ? `${stats.activeAccounts}/${stats.totalAccounts}` : undefined
          }
          loading={statsLoading}
          icon={Mail}
        />
        <StatCard
          title="Forwarded"
          value={stats?.forwardedCount}
          loading={statsLoading}
          icon={ArrowRight}
        />
        {/* Archived mail is counted apart from keyword matches: it is an
            unfiltered record, not an attention queue. */}
        <StatCard
          title="Archived Mail"
          value={stats?.archivedTotal}
          loading={statsLoading}
          icon={Archive}
          href="/inbox"
        />
      </div>

      {/* Charts Row */}
      <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
        <div className="pin-card p-4 sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 shrink-0 text-sidebar-primary" />
            <h3 className="font-semibold text-foreground">
              Keyword Distribution
            </h3>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Matches broken down by triggering keyword
          </p>
          {keywordsLoading ? (
            <div className="flex h-[220px] items-center justify-center sm:h-[250px]">
              <Skeleton className="h-[180px] w-[180px] rounded-full" />
            </div>
          ) : keywordBreakdownList.length > 0 ? (
            <>
              <div className="h-[180px] sm:h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={keywordBreakdownList}
                      cx="50%"
                      cy="50%"
                      // Percentage radii scale with the container instead of
                      // staying a fixed 160px at every width.
                      innerRadius="55%"
                      outerRadius="80%"
                      paddingAngle={4}
                      dataKey="count"
                      nameKey="keyword"
                      stroke="none"
                    >
                      {keywordBreakdownList.map((entry, index) => (
                        <Cell
                          key={`cell-${entry.keyword}`}
                          fill={COLORS[index % COLORS.length]}
                        />
                      ))}
                    </Pie>
                    {!isMobile && (
                      <Legend
                        iconType="circle"
                        iconSize={8}
                        formatter={(value) => (
                          <span className="text-xs text-foreground/70">
                            {value}
                          </span>
                        )}
                      />
                    )}
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* Explicit value list: the numbers were previously only reachable
                  through a hover tooltip, which touch cannot trigger. */}
              <ul className="mt-3 space-y-1.5">
                {keywordBreakdownList.map((entry, index) => (
                  <li
                    key={entry.keyword}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: COLORS[index % COLORS.length] }}
                    />
                    <span className="pin-break min-w-0 flex-1 text-foreground/80">
                      {entry.keyword}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {entry.count}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="flex h-[180px] flex-col items-center justify-center text-center text-muted-foreground">
              <Inbox className="mb-2 h-10 w-10 opacity-20" />
              <p className="text-sm">No keyword data yet</p>
            </div>
          )}
        </div>

        <div className="pin-card p-4 sm:p-6">
          <div className="mb-3 flex items-center gap-2">
            <Mail className="h-5 w-5 shrink-0 text-sidebar-primary" />
            <h3 className="font-semibold text-foreground">Account Activity</h3>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Total matches per monitored inbox
          </p>
          {activityLoading ? (
            <Skeleton className="h-[220px] w-full sm:h-[250px]" />
          ) : accountActivityList.length > 0 ? (
            // Horizontal bars on mobile: vertical bars forced account labels
            // onto a shared x-axis where recharts dropped or overlapped them.
            <div
              style={{
                height: isMobile
                  ? Math.max(160, accountActivityList.length * 44)
                  : 250,
              }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={accountActivityList}
                  layout={isMobile ? "vertical" : "horizontal"}
                  margin={
                    isMobile
                      ? { top: 4, right: 32, left: 4, bottom: 4 }
                      : { top: 10, right: 12, left: 0, bottom: 0 }
                  }
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={isMobile}
                    horizontal={!isMobile}
                    stroke="hsl(var(--border))"
                  />
                  {isMobile ? (
                    <>
                      <XAxis type="number" hide />
                      <YAxis
                        type="category"
                        dataKey="label"
                        width={96}
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "hsl(var(--muted-foreground))" }}
                      />
                    </>
                  ) : (
                    <>
                      <XAxis
                        dataKey="label"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                        tick={{ fill: "hsl(var(--muted-foreground))" }}
                      />
                      <YAxis
                        allowDecimals={false}
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: "hsl(var(--muted-foreground))" }}
                      />
                    </>
                  )}
                  <Bar
                    dataKey="matchCount"
                    name="Matches"
                    fill="hsl(var(--primary))"
                    radius={isMobile ? [0, 6, 6, 0] : [6, 6, 0, 0]}
                    maxBarSize={isMobile ? 20 : 40}
                  >
                    {/* Value labels replace the pointer-only tooltip. */}
                    <LabelList
                      dataKey="matchCount"
                      position={isMobile ? "right" : "top"}
                      className="fill-foreground"
                      fontSize={11}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[180px] flex-col items-center justify-center text-center text-muted-foreground">
              <Mail className="mb-2 h-10 w-10 opacity-20" />
              <p className="text-sm">No account activity yet</p>
            </div>
          )}
        </div>
      </div>

      {/* Recent Matches */}
      <div className="pin-card">
        <div className="flex items-center justify-between gap-3 p-4 pb-3 sm:p-6 sm:pb-4">
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground">Recent Matches</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Latest flagged emails requiring attention
            </p>
          </div>
          <Link
            href="/messages"
            className="shrink-0 text-sm font-medium text-sidebar-primary hover:underline"
          >
            View all →
          </Link>
        </div>
        <div className="px-4 pb-4 sm:px-6 sm:pb-6">
          {messagesLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : recentMessagesList.length > 0 ? (
            <div className="space-y-3">
              {recentMessagesList.map((msg) => (
                <div
                  key={msg.id}
                  className="flex flex-col justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 transition-all duration-150 active:bg-white/[0.06] sm:flex-row sm:items-start sm:gap-4 sm:p-4 md:hover:bg-white/[0.06]"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="pin-break text-sm font-semibold">
                        {msg.subject}
                      </span>
                      {msg.forwarded && (
                        <Badge className="h-5 rounded-full border-green-500/25 bg-green-500/10 px-2 text-[11px] uppercase text-green-400">
                          Forwarded
                        </Badge>
                      )}
                    </div>
                    <div className="pin-break text-xs text-muted-foreground">
                      From:{" "}
                      <span className="text-foreground/80">
                        {msg.fromAddress}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {msg.matchedKeywords.map((k) => (
                        <span key={k} className="pin-badge">
                          {k}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground sm:min-w-[110px] sm:text-right">
                    <span className="font-medium text-foreground/70">
                      {format(new Date(msg.receivedAt), "MMM d, yyyy")}
                    </span>
                    <span className="sm:block">
                      {" "}
                      {format(new Date(msg.receivedAt), "HH:mm")}
                    </span>
                    <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground sm:justify-end">
                      {msg.accountDeleted ? (
                        <Archive className="h-3 w-3 shrink-0" />
                      ) : null}
                      <span className="truncate">{msg.accountLabel}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-10 text-center text-muted-foreground">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-muted/50">
                <Inbox className="h-7 w-7 opacity-40" />
              </div>
              <p className="text-sm font-medium">No recent matches found</p>
              <p className="mx-auto mt-1 max-w-xs text-xs">
                Incoming emails matching your keywords will appear here
                automatically.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  loading,
  icon: Icon,
  href,
}: {
  title: string;
  value?: number | string;
  loading: boolean;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** When set, the whole card links to the matching list. */
  href?: string;
}) {
  const body = (
    <>
      <div className="mb-2 flex items-start justify-between gap-2 sm:mb-3 sm:items-center">
        <span className="pin-meta-label leading-tight">{title}</span>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10 sm:h-8 sm:w-8">
          <Icon className="h-4 w-4 text-sidebar-primary" />
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <div className="text-xl font-bold tracking-tight tabular-nums text-foreground sm:text-2xl">
          {value ?? "—"}
        </div>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="pin-card block p-3.5 sm:p-5">
        {body}
      </Link>
    );
  }

  return <div className="pin-card p-3.5 sm:p-5">{body}</div>;
}
