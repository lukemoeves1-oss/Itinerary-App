// Creates a Stripe Checkout Session so the customer pays before generating.
// Uses Stripe's hosted payment page — card details never touch your server.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Server is missing STRIPE_SECRET_KEY. Add it in your Vercel dashboard.' });
  }

  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = `${proto}://${host}`;

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${origin}/?paid={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url', `${origin}/?canceled=1`);
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', '1999'); // $19.99 — amount is in cents
    params.append('line_items[0][price_data][product_data][name]', 'Custom Travel Itinerary — Explormint');

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error?.message || 'Stripe error creating checkout.' });
    }
    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unexpected error creating checkout.' });
  }
}
