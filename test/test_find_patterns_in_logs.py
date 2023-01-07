import unittest
from find_patterns_in_logs import *

class TestFindPatternsInLogs(unittest.TestCase):

    def test_extract_info(self):
        dependencies, error_messages = extract_info_from_log_file(
            "test/resources/precompile_before_list_deps.txt"
        )
        self.assertEqual(len(dependencies), 186)

if __name__ == '__main__':
    unittest.main()
