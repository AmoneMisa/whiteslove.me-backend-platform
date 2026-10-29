import unittest

import train_spans as T


def tokens(n):
    ids = [0] + list(range(100, 100 + n)) + [2]
    offsets = [(0, 0)] + [(i * 3, i * 3 + 2) for i in range(n)] + [(0, 0)]
    return ids, offsets


class SplitWindows(unittest.TestCase):
    def test_a_short_text_is_one_window_that_owns_everything(self):
        ids, offsets = tokens(40)
        (window,) = T.split_windows(ids, offsets, 256)
        self.assertEqual(window[0], ids)
        self.assertEqual((window[2], window[3]), (0, float("inf")))

    def test_every_token_start_is_owned_once_and_lies_inside_its_owner(self):
        ids, offsets = tokens(700)
        windows = T.split_windows(ids, offsets, 256)
        self.assertGreater(len(windows), 1)
        for w_ids, w_offsets, lo, hi in windows:
            self.assertLessEqual(len(w_ids), 256)
            self.assertEqual((w_ids[0], w_ids[-1]), (0, 2))
        for start, _ in offsets[1:-1]:
            owners = [w for w in windows if w[2] <= start < w[3]]
            self.assertEqual(len(owners), 1)
            body = owners[0][1][1:-1]
            self.assertTrue(body[0][0] <= start <= body[-1][0])

    def test_neighbouring_windows_share_the_overlap(self):
        ids, offsets = tokens(700)
        windows = T.split_windows(ids, offsets, 256)
        first, second = windows[0][1][1:-1], windows[1][1][1:-1]
        self.assertEqual(len(set(first) & set(second)), T.OVERLAP)


if __name__ == "__main__":
    unittest.main()
