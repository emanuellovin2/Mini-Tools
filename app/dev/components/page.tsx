import { redirect } from "next/navigation";
import {
  Button,
  Badge,
  Skeleton,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Input,
  Label,
} from "@/components/ui";
import { KpiCard } from "@/components/ui/KpiCard";
import { DenseTable, DenseRow, DenseCell } from "@/components/ui/DenseTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sparkline } from "@/components/ui/Sparkline";
import { PageHeader } from "@/components/layout/PageHeader";

if (process.env.NODE_ENV !== "development") {
  redirect("/");
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground border-b border-border pb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function ComponentsPage() {
  const sparkData = [12, 18, 14, 22, 19, 28, 25, 32, 27, 35];

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-12">
      <PageHeader
        title="Component Library"
        description="Design system v2 — development only"
      />

      <Section title="Buttons">
        <div className="flex flex-wrap gap-2">
          <Button variant="default">Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="ghost">Ghost</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs">XS</Button>
          <Button size="sm">SM</Button>
          <Button size="md">MD</Button>
          <Button size="lg">LG</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge variant="default">Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="ok">OK</Badge>
          <Badge variant="warn">Warn</Badge>
          <Badge variant="bad">Bad</Badge>
        </div>
      </Section>

      <Section title="KPI Cards">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <KpiCard
            label="Monthly Revenue"
            value="$12,450"
            delta={8.2}
            sub="vs last month"
            sparkline={sparkData}
          />
          <KpiCard
            label="Churn Rate"
            value="2.4%"
            delta={-1.1}
            sub="trailing 30 days"
          />
          <KpiCard
            label="Active Subs"
            value="342"
            delta={12}
            sub="+12 this month"
            sparkline={[20, 22, 24, 23, 28, 30, 29, 34]}
          />
        </div>
      </Section>

      <Section title="Sparkline">
        <div className="flex items-center gap-6">
          <Sparkline points={sparkData} width={120} height={40} color="var(--color-primary)" fill />
          <Sparkline points={[30, 25, 28, 20, 24, 18, 22, 15]} width={120} height={40} color="var(--color-bad)" fill />
          <Sparkline points={[10, 12, 11, 13, 12, 14, 13, 15, 14, 16]} width={120} height={40} />
        </div>
      </Section>

      <Section title="Skeleton">
        <div className="space-y-4">
          <Skeleton variant="line" className="w-48" />
          <Skeleton variant="line" lines={3} />
          <div className="flex items-center gap-3">
            <Skeleton variant="avatar" className="w-10 h-10" />
            <Skeleton variant="line" lines={2} className="flex-1" />
          </div>
          <Skeleton variant="rect" className="h-32 w-full" />
        </div>
      </Section>

      <Section title="Dense Table">
        <DenseTable
          cols={["App", "Status", "MRR", "Subs"]}
        >
          <DenseRow>
            <DenseCell>Acme Analytics</DenseCell>
            <DenseCell><Badge variant="ok">Active</Badge></DenseCell>
            <DenseCell>$1,240</DenseCell>
            <DenseCell>34</DenseCell>
          </DenseRow>
          <DenseRow>
            <DenseCell>DevTools Pro</DenseCell>
            <DenseCell><Badge variant="warn">Trialing</Badge></DenseCell>
            <DenseCell>$480</DenseCell>
            <DenseCell>12</DenseCell>
          </DenseRow>
          <DenseRow>
            <DenseCell>LogoMaker</DenseCell>
            <DenseCell><Badge variant="bad">Churned</Badge></DenseCell>
            <DenseCell>$0</DenseCell>
            <DenseCell>0</DenseCell>
          </DenseRow>
        </DenseTable>
      </Section>

      <Section title="Empty State">
        <EmptyState
          icon={
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="4" y="4" width="24" height="24" rx="4" />
              <line x1="10" y1="16" x2="22" y2="16" />
              <line x1="16" y1="10" x2="16" y2="22" />
            </svg>
          }
          title="No apps yet"
          body="Submit your first app to get started on the marketplace."
          cta={<Button size="sm">Submit App</Button>}
        />
      </Section>

      <Section title="Form Inputs">
        <div className="space-y-3 max-w-sm">
          <div>
            <Label htmlFor="demo-input">App Name</Label>
            <Input id="demo-input" placeholder="e.g. Acme Analytics" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="demo-input-2">Price (cents)</Label>
            <Input id="demo-input-2" type="number" placeholder="2900" className="mt-1" />
          </div>
        </div>
      </Section>

      <Section title="Cards">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Revenue Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-[13px] text-muted-foreground">Card body content goes here.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>App Stats</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-[13px] text-muted-foreground">Another card with content.</p>
            </CardContent>
          </Card>
        </div>
      </Section>
    </div>
  );
}
