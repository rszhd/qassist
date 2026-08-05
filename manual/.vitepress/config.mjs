import { defineConfig } from 'vitepress';

const APP_URL = 'https://app.qassist.run';
const DEMO_URL = 'https://demo.qassist.run';
const REPO_URL = 'https://github.com/rszhd/qassist';

export default defineConfig({
  title: 'QAssist',
  description: 'Goal-based browser testing: write a goal, read a verdict.',
  lang: 'en-US',
  srcDir: '.',
  outDir: '.vitepress/dist',

  // Dark is the app's identity and the only theme it ships (docs/design-system.md),
  // so the manual does not offer a switch the product does not have.
  appearance: 'force-dark',

  // Left at the default deliberately, and it is what keeps the server config
  // out of this stack: emitted links carry `.html`, so stock nginx serves every
  // page with no `try_files` rule and no mounted config file. Turning it on
  // means writing an nginx.conf, which US-070 is specifically avoiding.
  cleanUrls: false,

  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#121417' }],
  ],

  themeConfig: {
    logo: '/qassist-mark.svg',
    search: { provider: 'local' },

    nav: [
      { text: 'Manual', link: '/first-run' },
      { text: 'Self-hosting', link: '/self-hosting' },
      { text: 'Open the app', link: APP_URL },
      { text: 'Try the demo', link: DEMO_URL },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'What QAssist is', link: '/' },
          { text: 'Your first run', link: '/first-run' },
          { text: 'Writing a goal', link: '/writing-goals' },
          { text: 'Reading a verdict', link: '/reading-a-verdict' },
        ],
      },
      {
        text: 'Building a suite',
        items: [
          { text: 'Saving a test', link: '/saved-tests' },
          { text: 'Projects, modules and suites', link: '/organizing' },
          { text: 'Variables and secrets', link: '/variables' },
          { text: 'Files a run can upload', link: '/files' },
        ],
      },
      {
        text: 'Running without you',
        items: [
          { text: 'Schedules', link: '/schedules' },
          { text: 'Triggering from CI', link: '/ci' },
          { text: 'Email notifications', link: '/notifications' },
        ],
      },
      {
        text: 'Testing a real app',
        items: [
          { text: 'Behind your login', link: '/saved-sessions' },
          { text: 'Where a run may go', link: '/navigation-fence' },
          { text: 'When a run goes wrong', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Running it yourself',
        items: [
          { text: 'Self-hosting', link: '/self-hosting' },
          { text: 'Settings', link: '/settings' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: REPO_URL }],

    editLink: {
      pattern: `${REPO_URL}/edit/dev/manual/:path`,
      text: 'Suggest a change to this page',
    },

    footer: {
      message: 'AGPL-3.0-only. Self-hosting is free, for anything, forever.',
      copyright: `<a href="${REPO_URL}">Source on GitHub</a>`,
    },

    outline: [2, 3],
  },
});
