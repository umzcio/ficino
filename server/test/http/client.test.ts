import { describe, expect, it } from 'vitest';
import { client, testApp } from '../helpers/client.js';

describe('test client cookie jar', () => {
  it('Max-Age=0, expired Expires and empty values remove cookies', async () => {
    const app = testApp();
    app.get('/__t/set', (c) => {
      c.header('Set-Cookie', 'a=1; Path=/', { append: true });
      c.header('Set-Cookie', 'b=2; Path=/', { append: true });
      c.header('Set-Cookie', 'c=3; Path=/', { append: true });
      return c.json({});
    });
    app.get('/__t/clear', (c) => {
      c.header('Set-Cookie', 'a=; Path=/', { append: true });
      c.header('Set-Cookie', 'b=2; Max-Age=0; Path=/', { append: true });
      c.header('Set-Cookie', 'c=3; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/', { append: true });
      return c.json({});
    });
    const cl = client(app);
    await cl.get('/__t/set');
    expect([...cl.cookies.keys()].sort()).toEqual(['a', 'b', 'c', 'ficino_csrf']);
    await cl.get('/__t/clear');
    expect([...cl.cookies.keys()]).toEqual(['ficino_csrf']);
  });
});
