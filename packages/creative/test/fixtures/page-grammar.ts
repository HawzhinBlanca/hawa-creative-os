/** Synthetic client-neutral admission fixture; not an approved client guideline. */
export const GRAMMAR_PALETTE = ['#FFFFFF', '#112233', '#336699', '#FFD700'];
export function grammarFixture() {
  const stops = () => [{ at: 0, color: '#336699' }, { at: 1, color: '#FFD700' }];
  const type = () => ({ fontFamily: 'Inter', color: '#112233', sizeShare: 0.03, lineHeight: 1.5 });
  const card = () => ({ fill: '#FFFFFF', title: '#336699', text: '#112233' });
  return {
    source: 'Synthetic grammar admission control',
    page: { background: '#FFFFFF', marginShare: 0.07 },
    header: { logoWidthShare: 0.12, rule: { color: '#112233', opacity: 0.1, thicknessShare: 0.003 },
      accent: { widthShare: 0.11, thicknessShare: 0.004, stops: stops() }, label: type() },
    title: { ...type(), bold: true, colorOnDark: '#FFFFFF', letterSpacing: -0.01 },
    titleBar: { widthShare: 0.085, heightShare: 0.0065, gapShare: 0.018, stops: stops() },
    lead: { ...type(), italic: true }, body: type(),
    cards: { radiusShare: 0.012, shadow: { color: '#112233', opacity: 0.1, blurShare: 0.02, offsetShare: 0.005 },
      plain: card(), brand: card(), tint: { ...card(), edge: '#FFD700', edgeShare: 0.005 }, dark: card() },
    stat: { fontFamily: 'Inter', bold: true, colorOnDark: '#FFD700', colorOnLight: '#336699',
      labelColor: '#336699', labelColorOnDark: '#FFFFFF' },
    footRule: { heightShare: 0.005, stops: stops() },
    cover: { angle: 45, stops: stops(), logoWidthShare: 0.3, title: '#FFFFFF', body: '#FFFFFF',
      subtitle: { fontFamily: 'Inter', color: '#FFD700', letterSpacing: 0.1, sizeShare: 0.03 } },
    elements: { sunburst: { color: '#112233', opacityOnLight: 0.06, colorOnDark: '#336699', opacityOnDark: 0.14, rays: 5 },
      trianglePattern: { color: '#336699', opacityOnLight: 0.1, colorOnDark: '#336699', opacityOnDark: 0.16 },
      rule: 'Synthetic optional ornament instruction' },
  };
}
