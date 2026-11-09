import copy
import json
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from specgap.errors import ProviderError
from specgap.provider import SYSTEM_PROMPT, request_review
from tests.review_fixture import bundle_fixture, review_fixture


def response_for(review, finish_reason='stop'):
    return json.dumps({'choices': [{'finish_reason': finish_reason, 'message': {'content': json.dumps(review)}}]}).encode()


@contextmanager
def server(body, status=200, headers=None):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers['Content-Length']))
            requests.append({'body': json.loads(raw), 'auth': self.headers.get('Authorization')})
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{httpd.server_port}/v1/chat/completions', requests
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


class ProviderTests(unittest.TestCase):
    def call(self, endpoint, **kwargs):
        return request_review(bundle_fixture(), endpoint=endpoint, model='test-model', api_key='private-test-key', **kwargs)

    def test_prompt_requires_chinese_prose_without_changing_machine_fields_or_quotes(self):
        self.assertIn('简体中文', SYSTEM_PROMPT)
        for field in ('reason', 'summary', 'title', 'description', 'question', 'test_ideas'):
            self.assertIn(field, SYSTEM_PROMPT)
        self.assertIn('Do not translate', SYSTEM_PROMPT)
        self.assertIn('enum', SYSTEM_PROMPT)
        self.assertIn('Quote exact complete frozen lines', SYSTEM_PROMPT)

    def test_no_network_without_explicit_opt_in(self):
        with patch('specgap.provider.urllib.request.build_opener') as opener:
            with self.assertRaises(ProviderError):
                self.call('https://example.invalid/v1/chat/completions')
            opener.assert_not_called()

    def test_real_loopback_http_and_sanitized_outbound_metadata(self):
        bundle = bundle_fixture()
        before = copy.deepcopy(bundle)
        with server(response_for(review_fixture())) as (endpoint, requests):
            review = request_review(bundle, endpoint=endpoint, model='local-test', api_key='private-test-key', allow_network=True)
        self.assertEqual(review, review_fixture())
        self.assertEqual(bundle, before)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]['auth'], 'Bearer private-test-key')
        user = json.loads(requests[0]['body']['messages'][1]['content'])
        self.assertNotIn('root', user['bundle']['repo'])
        self.assertNotIn('path', user['bundle']['requirements'])
        self.assertIn('untrusted', requests[0]['body']['messages'][0]['content'].lower())
        self.assertIn('简体中文', requests[0]['body']['messages'][0]['content'])

    def test_unsafe_endpoints_rejected_without_connection(self):
        with patch('specgap.provider.urllib.request.build_opener') as opener:
            for url in ['http://external.example/api', 'ftp://127.0.0.1/x', 'https://user:pass@example.com/api',
                        'https://example.com/x?key=secret', 'https://example.com/x#secret', 'http://127.0.0.1:bad/api',
                        'https://example.com/\nheader']:
                with self.subTest(url=url), self.assertRaises(ProviderError):
                    self.call(url, allow_network=True)
            opener.assert_not_called()

    def test_redirect_is_not_followed(self):
        with server(b'', 302, {'Location': '/stolen'}) as (endpoint, requests):
            with self.assertRaises(ProviderError):
                self.call(endpoint, allow_network=True)
        self.assertEqual(len(requests), 1)

    def test_http_errors_do_not_disclose_provider_body_or_key(self):
        with server(b'private-test-key raw error secret body', 429) as (endpoint, _):
            with self.assertRaises(ProviderError) as context:
                self.call(endpoint, allow_network=True)
        self.assertIn('429', str(context.exception))
        self.assertNotIn('private-test-key', str(context.exception))
        self.assertNotIn('secret body', str(context.exception))

    def test_malformed_truncated_duplicate_and_oversize_responses_rejected(self):
        malformed = [b'not JSON', b'{"choices":[],"choices":[]}', b'{"choices":[]}',
                     response_for(review_fixture(), 'length'), b'x' * (1048576 + 1),
                     b'{"choices":[{"finish_reason":"stop","message":{"content":"{\\"x\\":1,\\"x\\":2}"}}]}']
        for body in malformed:
            with self.subTest(size=len(body)), server(body) as (endpoint, _), self.assertRaises(ProviderError):
                self.call(endpoint, allow_network=True)

    def test_fabricated_citations_and_compressed_body_rejected(self):
        review = review_fixture()
        review['requirements'][0]['evidence'][0]['quote'] = 'made up'
        with server(response_for(review)) as (endpoint, _), self.assertRaises(ProviderError):
            self.call(endpoint, allow_network=True)
        with server(response_for(review_fixture()), headers={'Content-Encoding': 'gzip'}) as (endpoint, _), self.assertRaises(ProviderError):
            self.call(endpoint, allow_network=True)

    def test_timeout_redacts_details(self):
        with patch('specgap.provider.urllib.request.build_opener') as opener:
            opener.return_value.open.side_effect = TimeoutError('private-test-key')
            with self.assertRaises(ProviderError) as context:
                self.call('https://example.invalid/api', allow_network=True)
        self.assertNotIn('private-test-key', str(context.exception))

    def test_missing_key_model_and_invalid_timeout(self):
        for fields in [{'api_key': ''}, {'api_key': 'secret\ninjection'}, {'model': ''}, {'timeout': 0}]:
            options = dict(endpoint='https://example.invalid/api', model='test', api_key='test', allow_network=True)
            options.update(fields)
            with self.subTest(fields=fields), self.assertRaises(ProviderError):
                request_review(bundle_fixture(), **options)
