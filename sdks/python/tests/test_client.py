import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fleet_canvas import FleetApiError, FleetClient


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/snapshot":
            self._json(200, {"version": "2.0.0"})
        else:
            self._json(404, {"error": "missing"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        self._json(201, {"path": self.path, "body": body, "authorization": self.headers.get("authorization")})

    def log_message(self, *_args):
        pass

    def _json(self, status, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = FleetClient(f"http://127.0.0.1:{cls.server.server_port}", "token")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_snapshot(self):
        self.assertEqual(self.client.snapshot()["version"], "2.0.0")

    def test_pipeline(self):
        result = self.client.run_pipeline("train", {"dataset": "v14"})
        self.assertEqual(result["body"]["parameters"]["dataset"], "v14")
        self.assertEqual(result["authorization"], "Bearer token")

    def test_error(self):
        with self.assertRaises(FleetApiError) as caught:
            self.client.request("/missing")
        self.assertEqual(caught.exception.status, 404)

    def test_rejects_credential_url_and_bad_resource(self):
        with self.assertRaises(ValueError):
            FleetClient("https://user:password@example.test")
        with self.assertRaises(ValueError):
            self.client.list("1invalid")

    def test_validates_power_actions(self):
        with self.assertRaises(ValueError):
            self.client.power([], "wake")
        with self.assertRaises(ValueError):
            self.client.power(["device-1"], "destroy")


if __name__ == "__main__":
    unittest.main()
