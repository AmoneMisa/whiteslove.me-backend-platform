import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app import (
    _facebook_playwright_cookies,
    _facebook_target,
    _parse_facebook_cookies,
    _parse_linkedin_jobs_html,
    _threads_username,
    _validate_public_url,
    fetch_facebook,
)
from main import (
    _duckduckgo_target,
    _threads_query,
    app as production_app,
    fetch_linkedin_candidates,
)


class SocialFetcherTests(unittest.TestCase):
    def test_facebook_group_url(self):
        self.assertEqual(
            _facebook_target('https://www.facebook.com/groups/123456789/'),
            {'kind': 'group', 'value': '123456789'},
        )

    def test_facebook_page_slug(self):
        self.assertEqual(
            _facebook_target('some.public.page'),
            {'kind': 'page', 'value': 'some.public.page'},
        )

    def test_parse_facebook_cookies_header_string(self):
        self.assertEqual(
            _parse_facebook_cookies('c_user=100012345; xs=abc123; sb=xyz'),
            {'c_user': '100012345', 'xs': 'abc123', 'sb': 'xyz'},
        )

    def test_parse_facebook_cookies_json(self):
        self.assertEqual(
            _parse_facebook_cookies('{"c_user": "100012345", "xs": "abc123"}'),
            {'c_user': '100012345', 'xs': 'abc123'},
        )

    def test_parse_facebook_cookies_blank(self):
        self.assertIsNone(_parse_facebook_cookies(''))
        self.assertIsNone(_parse_facebook_cookies(None))

    def test_facebook_playwright_cookies_shape(self):
        with patch('app.FACEBOOK_COOKIES', {'c_user': '1', 'xs': '2'}):
            cookies = _facebook_playwright_cookies()
        self.assertEqual(
            sorted(cookies, key=lambda c: c['name']),
            [
                {'name': 'c_user', 'value': '1', 'domain': '.facebook.com', 'path': '/'},
                {'name': 'xs', 'value': '2', 'domain': '.facebook.com', 'path': '/'},
            ],
        )

    def test_facebook_playwright_cookies_empty_without_config(self):
        with patch('app.FACEBOOK_COOKIES', None):
            self.assertEqual(_facebook_playwright_cookies(), [])

    def test_fetch_facebook_passes_cookies_to_get_posts(self):
        post = {
            'post_id': 'post-1',
            'text': 'Сдам квартиру, 1 комната, 300 USD',
            'post_url': 'https://www.facebook.com/groups/123/posts/1/',
        }
        with (
            patch('app.FACEBOOK_COOKIES', {'c_user': '1', 'xs': '2'}),
            patch('app.get_posts', return_value=iter([post])) as get_posts_mock,
        ):
            fetch_facebook({'target': 'https://www.facebook.com/groups/123/', 'limit': 5})

        _, kwargs = get_posts_mock.call_args
        self.assertEqual(kwargs.get('cookies'), {'c_user': '1', 'xs': '2'})

    def test_facebook_keeps_existing_scraper_as_primary_path(self):
        post = {
            'post_id': 'post-123',
            'text': 'Сдам квартиру в Ташкенте, 2 комнаты, 500 USD',
            'post_url': 'https://www.facebook.com/groups/123/posts/456/',
            'time': '2026-08-31T12:00:00+00:00',
            'images': ['https://example.com/flat.jpg'],
        }
        with (
            patch('app.get_posts', return_value=iter([post])),
            patch('app._fetch_facebook_playwright') as fallback,
        ):
            result = fetch_facebook({
                'target': 'https://www.facebook.com/groups/123/',
                'limit': 20,
            })

        fallback.assert_not_called()
        self.assertEqual(result['fetchMode'], 'facebook-scraper')
        self.assertEqual(result['count'], 1)
        self.assertEqual(result['items'][0]['id'], 'post-123')

    def test_facebook_empty_primary_response_uses_playwright_fallback(self):
        browser_item = {
            'id': '456',
            'source': 'facebook',
            'target': 'https://www.facebook.com/groups/123/',
            'author': 'Owner',
            'text': 'Сдам квартиру в Ташкенте, 2 комнаты, 500 USD',
            'url': 'https://www.facebook.com/groups/123/posts/456/',
            'createdAt': None,
            'images': ['https://example.com/flat.jpg'],
            'video': None,
            'likes': None,
            'comments': None,
            'shares': None,
        }
        with (
            patch('app.get_posts', return_value=iter([])),
            patch('app._fetch_facebook_playwright', return_value=[browser_item]) as fallback,
        ):
            result = fetch_facebook({
                'target': 'https://www.facebook.com/groups/123/',
                'limit': 20,
            })

        fallback.assert_called_once()
        self.assertEqual(result['fetchMode'], 'playwright')
        self.assertEqual(result['count'], 1)
        self.assertEqual(result['items'][0]['id'], '456')

    def test_facebook_reports_both_transport_failures(self):
        with (
            patch('app.get_posts', side_effect=RuntimeError('Unsupported Browser')),
            patch(
                'app._fetch_facebook_playwright',
                side_effect=RuntimeError('Facebook public page is restricted: login wall'),
            ),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r'facebook-scraper=.*Unsupported Browser.*playwright=.*login wall',
            ):
                fetch_facebook({
                    'target': 'https://www.facebook.com/groups/123/',
                    'limit': 20,
                })

    def test_threads_username_validation(self):
        self.assertEqual(_threads_username('@white.love'), 'white.love')
        with self.assertRaises(ValueError):
            _threads_username('../bad')

    def test_threads_search_query_validation(self):
        self.assertEqual(_threads_query('  аренда Ташкент  '), 'аренда Ташкент')
        with self.assertRaises(ValueError):
            _threads_query('x')

    def test_production_entrypoint_registers_extended_routes(self):
        routes = {rule.rule for rule in production_app.url_map.iter_rules()}
        self.assertIn('/health', routes)
        self.assertIn('/fetch', routes)
        self.assertIn('/threads/search', routes)
        self.assertIn('/linkedin/jobs', routes)
        self.assertIn('/linkedin/candidates', routes)

    def test_threads_search_route_uses_main_extension(self):
        payload = {
            'ok': True,
            'source': 'threads',
            'mode': 'search',
            'query': 'аренда Ташкент',
            'count': 0,
            'items': [],
        }
        with patch('main.fetch_threads_search', return_value=payload):
            response = production_app.test_client().post(
                '/threads/search',
                json={'query': 'аренда Ташкент', 'limit': 20},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['mode'], 'search')

    def test_public_url_blocks_other_hosts(self):
        with self.assertRaises(ValueError):
            _validate_public_url('http://127.0.0.1:8080/private', {'linkedin.com'})
        self.assertEqual(
            _validate_public_url(
                'https://www.linkedin.com/jobs/view/123',
                {'linkedin.com'},
            ),
            'https://www.linkedin.com/jobs/view/123',
        )

    def test_linkedin_guest_card_parser(self):
        html = '''
        <ul>
          <li>
            <div data-entity-urn="urn:li:jobPosting:424242">
              <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/frontend-developer-424242"></a>
              <h3 class="base-search-card__title">Frontend Developer</h3>
              <h4 class="base-search-card__subtitle">Example LLC</h4>
              <span class="job-search-card__location">Tashkent, Uzbekistan</span>
              <time datetime="2026-08-22"></time>
            </div>
          </li>
        </ul>
        '''
        jobs = _parse_linkedin_jobs_html(html)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]['id'], '424242')
        self.assertEqual(jobs[0]['title'], 'Frontend Developer')
        self.assertEqual(jobs[0]['company'], 'Example LLC')
        self.assertEqual(jobs[0]['location'], 'Tashkent, Uzbekistan')

    def test_linkedin_candidate_discovery_accepts_public_profile_results(self):
        html = '''
        <div class="result">
          <a class="result__a" href="https://www.linkedin.com/in/example-person">
            Example Person - Frontend Developer | LinkedIn
          </a>
          <div class="result__snippet">Open to Work in Tashkent, Uzbekistan</div>
        </div>
        '''
        with patch('main._http_get', return_value=SimpleNamespace(text=html)):
            result = fetch_linkedin_candidates({
                'query': 'Open to Work Uzbekistan',
                'scope': 'profiles',
                'limit': 10,
            })
        self.assertEqual(result['count'], 1)
        self.assertEqual(result['items'][0]['kind'], 'profile')
        self.assertEqual(result['items'][0]['url'], 'https://www.linkedin.com/in/example-person')

    def test_linkedin_candidate_redirect_filter_rejects_other_hosts(self):
        self.assertEqual(
            _duckduckgo_target('https://example.com/in/not-linkedin'),
            '',
        )
        self.assertEqual(
            _duckduckgo_target('https://www.linkedin.com/posts/example-123?trk=public'),
            'https://www.linkedin.com/posts/example-123',
        )


if __name__ == '__main__':
    unittest.main()
