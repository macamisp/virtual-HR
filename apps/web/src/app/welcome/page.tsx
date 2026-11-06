import type { Metadata } from 'next';
import Image, { type StaticImageData } from 'next/image';
import { headers } from 'next/headers';
import {
  ArrowRight, Building2, CalendarCheck, CalendarClock, ChartColumn, Check, ChevronDown, Clock, EyeOff, FileLock2, Fingerprint,
  KeyRound, ListChecks, MapPin, MessagesSquare, MonitorUp, ScrollText, ShieldCheck, Timer, UserPlus, Users, Video,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { SITE_URL, siteHostOf } from '@/lib/site';
import styles from './landing.module.css';
import { MobileMenu, type NavLink } from './mobile-menu';
import attendanceShot from './shots/attendance.jpg';
import meetingsShot from './shots/meetings.jpg';
import officeShot from './shots/office.jpg';
import reportsShot from './shots/work-time-reports.jpg';
import tasksShot from './shots/tasks.jpg';
import workTimeShot from './shots/work-time.jpg';

/**
 * Public landing page (ADR 050), served at / on the marketing host (src/middleware.ts) and at
 * /welcome everywhere else. Static content only: no API calls, no cookies, no user data. Every
 * product and security statement here is backed by the code and an ADR; there are no invented
 * customers, figures, certifications or prices.
 */

const TITLE = 'Virtual-HR: virtual office, attendance and HR in one workspace';
const DESCRIPTION =
  'A shared online office with avatars, voice and video, automatic attendance from server records, tasks, smart time tracking, overtime and onsite approvals, and work-time analytics for remote and hybrid teams.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'Virtual-HR',
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: officeShot.src, width: officeShot.width, height: officeShot.height, alt: 'The Virtual-HR office map with three colleagues standing together in Reception' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [officeShot.src] },
  robots: { index: true, follow: true },
};

const NAV: NavLink[] = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

/** Links into the app: absolute on the marketing host, same-origin anywhere else (local preview at /welcome). */
async function appLinks(): Promise<{ login: string; signup: string }> {
  const h = await headers();
  const site = siteHostOf(h.get('host'), h.get('x-forwarded-proto') === 'https');
  const origin = site?.appOrigin ?? '';
  return { login: `${origin}/login`, signup: `${origin}/signup` };
}

export default async function LandingPage() {
  const links = await appLinks();
  return (
    <div className={`${styles.root} min-h-screen bg-background text-foreground`}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">
        Skip to content
      </a>
      <Header links={links} />
      <main id="main">
        <Hero links={links} />
        <Features />
        <HowItWorks />
        <Showcase />
        <Security />
        <Faq />
        <Closing links={links} />
      </main>
      <Footer links={links} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-primary" />
        <path d="M7 9h18v14H7z" fill="none" stroke="white" strokeOpacity=".55" strokeWidth="1.5" />
        <path d="M16 9v6M7 15h9" stroke="white" strokeOpacity=".55" strokeWidth="1.5" />
        <circle cx="11.5" cy="19.5" r="2.5" fill="white" />
        <circle cx="20.5" cy="17.5" r="2.5" fill="white" />
      </svg>
      <span className="text-lg">Virtual-HR</span>
    </span>
  );
}

const linkFocus = 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const primaryButton = `inline-flex items-center justify-center gap-2 bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 ${linkFocus}`;
const secondaryButton = `inline-flex items-center justify-center gap-2 border bg-background px-5 py-3 text-sm font-semibold transition-colors hover:bg-accent ${linkFocus}`;

function Header({ links }: { links: { login: string; signup: string } }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="#main" className={linkFocus} aria-label="Virtual-HR home">
          <Logo />
        </a>
        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((l) => (
              <li key={l.href}>
                <a href={l.href} className={`px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground ${linkFocus}`}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <a href={links.login} className={`hidden px-3 py-2 text-sm font-medium sm:inline-block md:inline-block ${linkFocus}`}>
            Log in
          </a>
          <a href={links.signup} className={`hidden rounded-md sm:inline-flex ${primaryButton} py-2`}>
            Get started
          </a>
          <MobileMenu links={NAV} loginHref={links.login} signupHref={links.signup} />
        </div>
      </div>
    </header>
  );
}

function BrowserFrame({ src, alt, priority = false, sizes }: { src: StaticImageData; alt: string; priority?: boolean; sizes: string }) {
  return (
    <figure className={`${styles.frame} overflow-hidden rounded-xl border bg-card`}>
      <div className="flex items-center gap-1.5 border-b bg-muted/60 px-3 py-2" aria-hidden="true">
        <span className="h-2.5 w-2.5 rounded-full bg-foreground/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-foreground/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-foreground/15" />
      </div>
      <Image src={src} alt={alt} sizes={sizes} priority={priority} placeholder="empty" className="h-auto w-full" />
    </figure>
  );
}

function Hero({ links }: { links: { login: string; signup: string } }) {
  return (
    <section aria-labelledby="hero-title" className={`${styles.hero} overflow-hidden`}>
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pt-20 lg:pb-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground sm:text-sm">
            <Building2 className="h-4 w-4 text-primary" aria-hidden="true" />
            Virtual office, attendance and HR in one workspace
          </p>
          <h1 id="hero-title" className="text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Your team&apos;s office, online. With the HR built in.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
            Walk over to a colleague, talk in a room, share your screen, and get on with the work. Attendance, time
            records, overtime and onsite approvals keep themselves up to date from server records, so nobody fills in a
            spreadsheet at the end of the week.
          </p>
          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <a href={links.signup} className={`${primaryButton} rounded-md text-base`}>
              Create your workspace <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
            <a href={links.login} className={`${secondaryButton} rounded-md text-base`}>
              Log in
            </a>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">Sign up with your work e-mail, confirm it, then invite your team.</p>
        </div>
        <div className="mx-auto mt-14 max-w-5xl">
          <BrowserFrame
            src={officeShot}
            priority
            sizes="(min-width: 1024px) 64rem, 100vw"
            alt="The Virtual-HR office map: three colleagues stand together in Reception, with desks and a lounge nearby, and a panel listing who is nearby."
          />
          <p className="mt-3 text-center text-xs text-muted-foreground">Screens from the Virtual-HR app with sample data.</p>
        </div>
      </div>
    </section>
  );
}

function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold uppercase tracking-wider text-primary">{eyebrow}</p>
      <h2 id={id} className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
      {children ? <p className="mt-4 text-pretty text-muted-foreground">{children}</p> : null}
    </div>
  );
}

const FEATURES: Array<{ icon: typeof Building2; title: string; body: string }> = [
  { icon: Building2, title: 'Virtual office', body: 'Move your avatar around a shared floor plan. See who is in which room, claim a desk, and knock before entering a closed room.' },
  { icon: Video, title: 'Voice and video', body: 'Start talking when you walk into a room or stand next to someone. Schedule meetings or start an instant call.' },
  { icon: MonitorUp, title: 'Screen sharing', body: 'Share your screen in a meeting or an office call. Viewers can expand and zoom it, go full screen, or pop it out into its own window.' },
  { icon: Clock, title: 'Automatic attendance', body: 'Clock-in and clock-out follow activity in the app, timed by the server clock. Active, idle, break and meeting time are kept apart.' },
  { icon: ListChecks, title: 'Tasks and projects', body: 'Assign work, accept it, discuss it with @mentions, and follow it on a board, a calendar or the team workload view.' },
  { icon: Timer, title: 'Smart time tracking', body: 'Run a timer on named work or add time by hand with a reason. Calls with other people count as meeting time.' },
  { icon: CalendarClock, title: 'Overtime approval', body: 'People ask for overtime before or after the fact, and their manager approves or declines it with a recorded decision.' },
  { icon: MapPin, title: 'Onsite work', body: 'Report a client visit or other work away from the app. Once approved it becomes a time entry, never fake attendance.' },
  { icon: CalendarCheck, title: 'Google Calendar', body: 'Connect a Google calendar to see upcoming meetings next to your work and keep scheduled meetings in step.' },
  { icon: ChartColumn, title: 'Analytics and reports', body: 'Compare estimated and actual time by task, see time by project, kind of work and place, and export to CSV or Excel.' },
  { icon: Users, title: 'HR management', body: 'Leave and public holidays, timesheets with approvals, teams and managers, documents and e-signatures in the same workspace.' },
  { icon: MessagesSquare, title: 'Chat', body: 'Direct and group conversations next to the office, plus chat inside every meeting.' },
];

function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="border-t bg-muted/30 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading id="features-title" eyebrow="Features" title="Everything a distributed team does in a day">
          One workspace for where people are, what they are working on, and the HR records that follow from it.
        </SectionHeading>
        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className={`${styles.reveal} rounded-xl border bg-card p-6 text-card-foreground transition-shadow hover:shadow-md`}>
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const STEPS: Array<{ icon: typeof Building2; title: string; body: string }> = [
  { icon: Building2, title: 'Create your workspace', body: 'Sign up with your e-mail address and confirm it. Owners, administrators and HR managers set up two-factor authentication on first sign-in.' },
  { icon: UserPlus, title: 'Invite your team', body: 'Send invitations by e-mail and choose each person’s role: employee, team lead, HR, administrator or subcontractor.' },
  { icon: Users, title: 'Work together', body: 'People open the office, meet and track their tasks. Attendance and timesheets fill in from server records, and managers review requests.' },
];

function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading id="how-title" eyebrow="How it works" title="Up and running in three steps" />
        <ol className="mt-14 grid gap-6 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className={`${styles.reveal} relative rounded-xl border bg-card p-6`}>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground" aria-hidden="true">
                  {i + 1}
                </span>
                <Icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-lg font-semibold"><span className="sr-only">Step {i + 1}: </span>{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const SHOWCASE: Array<{ id: string; eyebrow: string; title: string; body: string; points: string[]; shot: StaticImageData; alt: string }> = [
  {
    id: 'attendance', eyebrow: 'Attendance', title: 'Attendance that records itself',
    body: 'No clock-in button to forget. The working day starts and ends with activity in Virtual-HR, and every time comes from the server clock, not the device.',
    points: [
      'Active, idle, break and meeting time for each day and week',
      'Missed or wrong times go to a manager as a correction; the original record is kept',
      'A “What we collect” page shows every employee exactly what is recorded',
    ],
    shot: attendanceShot, alt: 'My attendance: today shows Active with the clock-in time, counters for active, idle, break, meeting and net work time, and the weekly record.',
  },
  {
    id: 'time', eyebrow: 'Smart time tracking', title: 'Time on named work, not guesswork',
    body: 'Start a timer on a task or on your own words, pause and resume it, or add work afterwards with a reason. Overtime and onsite work go through their own approval.',
    points: [
      'Timers start and stop on the server clock and stop on their own at clock-out',
      'Manual time is labelled as manual and needs a reason',
      'Overtime requests and onsite reports are reviewed by the manager',
    ],
    shot: workTimeShot, alt: 'My work time: a running timer on “Prepare November payroll summary”, a form to switch work, upcoming meetings and the last seven days of entries.',
  },
  {
    id: 'tasks', eyebrow: 'Tasks', title: 'Plans and progress in one place',
    body: 'Team leads assign tasks with a priority and an estimate; people accept, update and discuss them. Subcontractors accept work before they start.',
    points: [
      'Board, today, week, calendar and team workload views',
      'Comments with @mentions and a full activity history',
      'Estimates feed the estimated-versus-actual report',
    ],
    shot: tasksShot, alt: 'Task board created by a team lead: three tasks to do and one in progress, each with priority and assignee.',
  },
  {
    id: 'meetings', eyebrow: 'Meetings', title: 'Meet without leaving the office',
    body: 'Talk to whoever is in the room or next to you, or schedule a meeting with an agenda. Calls with at least one other person count as working time.',
    points: [
      'Voice, video and screen sharing, with chat inside the meeting',
      'Scheduled, recurring and instant meetings',
      'Recording is optional, off by default, and asks for consent',
    ],
    shot: meetingsShot, alt: 'Meetings: two upcoming meetings, Weekly team sync and Payroll review, each with a Join button.',
  },
  {
    id: 'analytics', eyebrow: 'Analytics', title: 'See where the time went',
    body: 'The work-time report brings attendance, meetings and time entries together for a person or a team, to help plan estimates and meetings.',
    points: [
      'Estimated versus actual time for every task',
      'Time by project, kind of work and place, with CSV and Excel export',
      'Figures describe time, not the quality or value of anyone’s work',
    ],
    shot: reportsShot, alt: 'Work-time report for a team: totals for attended, meeting and task time, a planning observation, and estimated versus actual time by task.',
  },
];

function Showcase() {
  return (
    <section aria-label="Product tour" className="border-t bg-muted/30 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl space-y-24 px-4 sm:px-6">
        {SHOWCASE.map((s, i) => (
          <article key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="grid items-center gap-10 lg:grid-cols-12">
            <div className={`lg:col-span-5 ${i % 2 ? 'lg:order-2' : ''}`}>
              <p className="text-sm font-semibold uppercase tracking-wider text-primary">{s.eyebrow}</p>
              <h2 id={`${s.id}-title`} className="mt-2 text-balance text-3xl font-bold tracking-tight">{s.title}</h2>
              <p className="mt-4 text-pretty text-muted-foreground">{s.body}</p>
              <ul className="mt-6 space-y-3">
                {s.points.map((p) => (
                  <li key={p} className="flex gap-3 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className={`${styles.reveal} lg:col-span-7 ${i % 2 ? 'lg:order-1' : ''}`}>
              <BrowserFrame src={s.shot} alt={s.alt} sizes="(min-width: 1024px) 40rem, 100vw" />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const SECURITY: Array<{ icon: typeof Building2; title: string; body: string }> = [
  { icon: KeyRound, title: 'Two-factor authentication', body: 'Authenticator-app codes with recovery codes. Required for administrators and HR managers, whatever the sign-in method.' },
  { icon: Fingerprint, title: 'Careful password handling', body: 'Passwords are hashed with Argon2id and checked against known breached passwords without sending the password anywhere.' },
  { icon: ShieldCheck, title: 'Workspaces kept apart', body: 'Every workspace’s records are separated in the database by PostgreSQL row-level security, not only by application code.' },
  { icon: FileLock2, title: 'Protected documents', body: 'Uploaded files are encrypted with envelope encryption and scanned for malware before anyone can open them.' },
  { icon: ScrollText, title: 'Audit trail', body: 'Sensitive actions such as approvals, corrections and role changes are written to an audit log.' },
  { icon: EyeOff, title: 'Proportionate monitoring', body: 'No screenshots, keystroke content or webcam capture. Employees can see what is collected and export their own data.' },
];

function Security() {
  return (
    <section id="security" aria-labelledby="security-title" className="py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionHeading id="security-title" eyebrow="Security and privacy" title="Built for records people can trust">
          How Virtual-HR protects accounts and data today, described as it is built.
        </SectionHeading>
        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SECURITY.map(({ icon: Icon, title, body }) => (
            <li key={title} className={`${styles.reveal} flex gap-4 rounded-xl border bg-card p-6`}>
              <Icon className="mt-0.5 h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const FAQ: Array<{ q: string; a: string }> = [
  { q: 'What is Virtual-HR?', a: 'A digital workplace for remote and hybrid teams: a shared virtual office with voice, video and screen sharing, combined with attendance, tasks, time tracking, approvals and HR records in one workspace.' },
  { q: 'Does Virtual-HR take screenshots or record keystrokes?', a: 'No. Attendance uses activity counters only: active and idle seconds, whether the tab is visible and whether you are in a call. No screenshots, keystroke content, URLs or webcam images are collected for monitoring.' },
  { q: 'How is attendance worked out?', a: 'Your day starts when you are active in Virtual-HR and ends when you leave or sign out. Every time comes from the server clock. Calls with at least one other person count as working time, and mistakes are fixed through a correction that a manager reviews.' },
  { q: 'How do overtime and onsite work get approved?', a: 'An employee submits an overtime request or an onsite work report, and their manager approves or declines it. Approved onsite work becomes a time entry; it is never turned into attendance.' },
  { q: 'Does it work with Google Calendar?', a: 'Yes. Each person can connect their own Google calendar to see upcoming meetings next to their work. Scheduled events do not count as worked time; joining the call does.' },
  { q: 'Do people need to install anything?', a: 'No. Virtual-HR runs in a modern web browser on desktop and mobile. Camera and microphone are used only when you turn on audio and video.' },
  { q: 'How do we get started?', a: 'Create a workspace with your e-mail address, confirm it, set up two-factor authentication as the owner, and invite your team by e-mail.' },
];

function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="border-t bg-muted/30 py-20 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <SectionHeading id="faq-title" eyebrow="FAQ" title="Questions people ask" />
        <div className="mt-12 divide-y rounded-xl border bg-card">
          {FAQ.map(({ q, a }) => (
            <details key={q} name="faq" className="group px-5 py-1 sm:px-6">
              <summary className={`flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium [&::-webkit-details-marker]:hidden ${linkFocus}`}>
                <h3 className="text-left">{q}</h3>
                <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
              </summary>
              <p className="pb-5 text-sm leading-relaxed text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing({ links }: { links: { login: string; signup: string } }) {
  return (
    <section aria-labelledby="closing-title" className="py-20 sm:py-24">
      <div className="mx-auto max-w-4xl px-4 text-center sm:px-6">
        <div className="rounded-2xl bg-primary px-6 py-14 text-primary-foreground sm:px-12">
          <h2 id="closing-title" className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">Bring your team into one office</h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty opacity-90">Create a workspace, invite your colleagues, and see the day come together.</p>
          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <a href={links.signup} className="inline-flex items-center justify-center gap-2 rounded-md bg-primary-foreground px-5 py-3 text-base font-semibold text-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary">
              Get started <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
            <a href={links.login} className="inline-flex items-center justify-center rounded-md border border-primary-foreground/40 px-5 py-3 text-base font-semibold transition-colors hover:bg-primary-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-primary">
              Log in
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer({ links }: { links: { login: string; signup: string } }) {
  return (
    <footer className="border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-3">
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">A virtual office with attendance, time and HR built in.</p>
        </div>
        <nav aria-label="Product">
          <h2 className="text-sm font-semibold">Product</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {NAV.map((l) => (
              <li key={l.href}><a href={l.href} className={`text-muted-foreground hover:text-foreground ${linkFocus}`}>{l.label}</a></li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Account">
          <h2 className="text-sm font-semibold">Account</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li><a href={links.signup} className={`text-muted-foreground hover:text-foreground ${linkFocus}`}>Create a workspace</a></li>
            <li><a href={links.login} className={`text-muted-foreground hover:text-foreground ${linkFocus}`}>Log in</a></li>
          </ul>
        </nav>
      </div>
      <div className="border-t">
        <p className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground sm:px-6">© {new Date().getFullYear()} Virtual-HR</p>
      </div>
    </footer>
  );
}
