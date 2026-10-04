import { isPackwizServer } from './packwiz';

describe('isPackwizServer', () => {
  it('is true for a server with a PACKWIZ_URL, whatever its loader type', () => {
    expect(
      isPackwizServer({
        type: 'FABRIC',
        env: { PACKWIZ_URL: 'https://example.com/pack.toml' },
      }),
    ).toBe(true);
  });

  it('is true for the legacy PACKWIZ type', () => {
    expect(isPackwizServer({ type: 'PACKWIZ', env: {} })).toBe(true);
  });

  it('is false for a server with no packwiz url, or an empty one', () => {
    expect(isPackwizServer({ type: 'FABRIC', env: {} })).toBe(false);
    expect(isPackwizServer({ type: 'FABRIC', env: { PACKWIZ_URL: '' } })).toBe(
      false,
    );
  });
});
