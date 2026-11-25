// Unit tests must be hermetic. createNode() with an embedded connector leaves
// ardriveEnabled unset, core defaults it to true, and every node.start() then
// asks the live Arweave gateway for ArDrive peers. That made unit tests wait on
// arweave.net and time out at 5s when it or the runner was slow. Answer the
// peer query with no peers instead. A test that stubs fetch itself still wins.
const realFetch = globalThis.fetch;

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

globalThis.fetch = (input, init) => {
  const url = urlOf(input);
  if (url.startsWith('https://arweave.net/graphql')) {
    return Promise.resolve(
      new Response(JSON.stringify({ data: { transactions: { edges: [] } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }
  return realFetch(input, init);
};
