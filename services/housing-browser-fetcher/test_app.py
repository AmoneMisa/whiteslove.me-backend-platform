import unittest
from unittest.mock import patch

import app as app_module


class HousingBrowserFetcherTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_health_lists_allowed_hosts(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("domza.uz", data["allowedHosts"])

    def test_rejects_non_https(self):
        resp = self.client.get("/fetch/html", query_string={"url": "http://domza.uz/"})
        self.assertEqual(resp.status_code, 400)

    def test_rejects_host_not_allowlisted(self):
        resp = self.client.get("/fetch/html", query_string={"url": "https://example.com/"})
        self.assertEqual(resp.status_code, 400)

    def test_renders_allowlisted_host(self):
        with patch.object(
            app_module, "render_html",
            return_value=("<html>ok</html>", "https://domza.uz/offers"),
        ):
            resp = self.client.get("/fetch/html", query_string={"url": "https://domza.uz/offers"})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["html"], "<html>ok</html>")
        self.assertEqual(data["finalUrl"], "https://domza.uz/offers")

    def test_rejects_redirect_off_allowlist(self):
        with patch.object(
            app_module, "render_html",
            return_value=("<html>evil</html>", "https://internal.example/"),
        ):
            resp = self.client.get("/fetch/html", query_string={"url": "https://domza.uz/"})
        self.assertEqual(resp.status_code, 502)

    def test_render_failure_is_a_502(self):
        with patch.object(app_module, "render_html", side_effect=RuntimeError("boom")):
            resp = self.client.get("/fetch/html", query_string={"url": "https://domza.uz/"})
        self.assertEqual(resp.status_code, 502)

    def test_normalized_host_strips_www_and_lowercases(self):
        self.assertEqual(app_module._normalized_host("WWW.Domza.uz"), "domza.uz")
        self.assertEqual(app_module._normalized_host(None), "")


if __name__ == "__main__":
    unittest.main()
