"""Exercise utility dependencies without model downloads or remote execution."""

import io
import tempfile
import unittest
from pathlib import Path

import aiohttp
import cbor2
import git
import msgpack
import orjson
import pyarrow as pa
import pyarrow.parquet as pq
import virtualenv
from aiohttp import web
from aiohttp.test_utils import TestServer
from filelock import FileLock
from google.protobuf.json_format import MessageToDict
from google.protobuf.struct_pb2 import Struct
from hydra.utils import instantiate
from omegaconf import OmegaConf
from opentelemetry.exporter.prometheus import PrometheusMetricReader
from opentelemetry.sdk.metrics import MeterProvider
from PIL import Image
from prometheus_client import CollectorRegistry, generate_latest


class PackageCompatibilityTests(unittest.TestCase):
    """Protect the data and local setup APIs used by training utilities."""

    def test_training_records_round_trip(self):
        """Nested conversation records survive supported binary and JSON codecs."""
        rows = [{"prompt": [{"role": "user", "content": "hello"}], "reward": 0.5}]
        for encode, decode in [(orjson.dumps, orjson.loads), (cbor2.dumps, cbor2.loads), (msgpack.packb, msgpack.unpackb)]:
            self.assertEqual(decode(encode(rows)), rows)
        sink = pa.BufferOutputStream()
        pq.write_table(pa.Table.from_pylist(rows), sink)
        self.assertEqual(pq.read_table(pa.BufferReader(sink.getvalue())).to_pylist(), rows)
        value = Struct()
        value.update(rows[0])
        self.assertEqual(MessageToDict(value), rows[0])

    def test_config_and_image_apis(self):
        """Hydra configuration and image decoding retain their existing APIs."""
        config = OmegaConf.create({"_target_": "builtins.dict", "batch_size": 4})
        self.assertEqual(instantiate(config), {"batch_size": 4})
        stream = io.BytesIO()
        Image.new("RGB", (4, 3), (20, 40, 60)).save(stream, format="PNG")
        stream.seek(0)
        with Image.open(stream) as result:
            self.assertEqual(result.size, (4, 3))
            self.assertEqual(result.getpixel((0, 0)), (20, 40, 60))

    def test_telemetry_exports_locally(self):
        """The pinned API, SDK and exporter cooperate without a telemetry endpoint."""
        registry = CollectorRegistry()
        provider = MeterProvider(metric_readers=[PrometheusMetricReader(registry=registry)])
        try:
            counter = provider.get_meter("compatibility").create_counter("fixture_count")
            counter.add(3, {"environment": "test"})
            output = generate_latest(registry)
            self.assertIn(b"fixture_count_total", output)
            self.assertIn(b"environment=\"test\"", output)
        finally:
            provider.shutdown()

    def test_local_repository_environment_and_lock(self):
        """Local Git snapshots and environment creation work without network access."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with FileLock(root / "setup.lock", timeout=1):
                repo = git.Repo.init(root / "repo")
                source = root / "repo" / "config.txt"
                source.write_text("batch_size=4\n")
                repo.index.add([str(source)])
                actor = git.Actor("Package test", "package-test@example.invalid")
                commit = repo.index.commit("Local fixture", author=actor, committer=actor)
                self.assertEqual(commit.tree["config.txt"].data_stream.read(), b"batch_size=4\n")
                virtualenv.cli_run([str(root / "environment"), "--no-seed"])
                self.assertTrue((root / "environment" / "pyvenv.cfg").is_file())


class HTTPCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    """Exercise the real asynchronous HTTP stack against loopback only."""

    async def test_local_json_request(self):
        """An HTTP JSON request preserves nested experiment metadata."""
        async def echo(request):
            """Return the test payload received by the local server."""
            return web.json_response(await request.json())

        app = web.Application()
        app.router.add_post("/echo", echo)
        async with TestServer(app) as server, aiohttp.ClientSession() as client:
            payload = {"run": "local-fixture", "metrics": [0.5, 1.0]}
            async with client.post(server.make_url("/echo"), json=payload) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(await response.json(), payload)


if __name__ == "__main__":
    unittest.main()
