from copy import deepcopy
import unittest

from tickerdata import AmbiguousSymbolError, UnknownSymbolError, lookup
from tickerdata import reader


class ReaderTests(unittest.TestCase):
    def test_canonical_and_provider_scoped_symbols(self):
        self.assertEqual(lookup(" nvda ")["symbol"]["canonical"], "NVDA")
        self.assertEqual(
            lookup("BRK-B", mic="xnys", provider="YAHOO")["symbol"]["canonical"],
            "BRK.B",
        )
        with self.assertRaises(UnknownSymbolError):
            lookup("BRK-B", provider="other")
        with self.assertRaises(UnknownSymbolError):
            lookup("BRK.B", mic="XNAS")

    def test_returns_copy_and_validates_inputs(self):
        record = lookup("NVDA")
        record["name"]["en"] = "mutated"
        self.assertNotEqual(lookup("NVDA")["name"]["en"], "mutated")
        for value in ("", None):
            with self.assertRaises(TypeError):
                lookup(value)
        with self.assertRaises(ValueError):
            lookup("NVDA", mic="US")
        with self.assertRaises(ValueError):
            lookup("NVDA", provider="Yahoo!")
        with self.assertRaises(TypeError):
            lookup("NVDA", include_inactive="yes")
        with self.assertRaises(UnknownSymbolError):
            lookup("MISSING")

    def test_ambiguity_and_active_filter(self):
        records = deepcopy(reader._records)
        entries = deepcopy(reader._entries_by_symbol)
        try:
            reader._records.clear()
            reader._records.update(
                {
                    "ins-first": {
                        "id": "ins-first",
                        "symbol": {"mic": "XNAS"},
                        "listing_status": "active",
                    },
                    "ins-second": {
                        "id": "ins-second",
                        "symbol": {"mic": "XNYS"},
                        "listing_status": "inactive",
                    },
                }
            )
            reader._entries_by_symbol.clear()
            reader._entries_by_symbol["SAME"] = [
                {
                    "symbol": "SAME",
                    "mic": "XNAS",
                    "provider": None,
                    "instrument_id": "ins-first",
                    "kind": "canonical",
                },
                {
                    "symbol": "SAME",
                    "mic": "XNYS",
                    "provider": None,
                    "instrument_id": "ins-second",
                    "kind": "canonical",
                },
            ]
            with self.assertRaises(AmbiguousSymbolError) as raised:
                lookup("SAME")
            self.assertEqual(
                [item["instrument_id"] for item in raised.exception.candidates],
                ["ins-first", "ins-second"],
            )
            self.assertEqual(lookup("SAME", include_inactive=False)["id"], "ins-first")
        finally:
            reader._records.clear()
            reader._records.update(records)
            reader._entries_by_symbol.clear()
            reader._entries_by_symbol.update(entries)


if __name__ == "__main__":
    unittest.main()
