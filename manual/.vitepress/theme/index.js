// `theme-without-fonts` rather than `theme`: the default theme bundles and
// preloads Inter, and the face here is Ubuntu, so the stock entry ships a font
// no page ever draws.
import DefaultTheme from 'vitepress/theme-without-fonts';
// Self-hosted rather than linked from a CDN, for the same two reasons the app
// self-hosts it (docs/design-system.md): a request per visitor to a third party
// the project gets nothing for, and a face that has to render where the CDN is
// unreachable.
import '@fontsource/ubuntu/latin-400.css';
import '@fontsource/ubuntu/latin-400-italic.css';
import '@fontsource/ubuntu/latin-500.css';
import '@fontsource/ubuntu/latin-700.css';
import './custom.css';

export default DefaultTheme;
