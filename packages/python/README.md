# tickerdata

Offline, versioned ticker metadata lookup for Python. The package contains a
fixed snapshot of reviewed metadata and never accesses the network.

```python
from tickerdata import lookup

instrument = lookup(
    "BRK-B",
    mic="XNYS",
    provider="yahoo",
    include_inactive=False,
)
```

`lookup` does not rewrite punctuation or guess between ambiguous listings.
Unknown and ambiguous queries raise `UnknownSymbolError` and
`AmbiguousSymbolError`.

This package provides metadata only. It does not provide market data, trading,
portfolio management, or investment advice.

The reader code is MIT licensed. Database rights in the maintained compilation
are licensed under ODC-By 1.0 subject to `NOTICE.md`; individual contents and
external materials may remain subject to their own terms.
