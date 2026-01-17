"""Tests for timefmt module."""

import pytest

from whisp.timefmt import format_duration, format_timestamp


class TestFormatTimestamp:
    """Tests for format_timestamp function."""

    def test_zero_seconds_short_audio(self):
        assert format_timestamp(0, 300) == "[00:00]"

    def test_zero_seconds_long_audio(self):
        assert format_timestamp(0, 3600) == "[00:00:00]"

    def test_59_seconds_short_audio(self):
        assert format_timestamp(59, 300) == "[00:59]"

    def test_59_minutes_59_seconds_short_audio(self):
        assert format_timestamp(3599, 3599) == "[59:59]"

    def test_1_hour_boundary(self):
        assert format_timestamp(3600, 3600) == "[01:00:00]"

    def test_mid_audio_short(self):
        assert format_timestamp(125, 300) == "[02:05]"

    def test_mid_audio_long(self):
        assert format_timestamp(4805, 7200) == "[01:20:05]"

    def test_fractional_seconds_truncated(self):
        assert format_timestamp(125.9, 300) == "[02:05]"


class TestFormatDuration:
    """Tests for format_duration function."""

    def test_zero_seconds(self):
        assert format_duration(0) == "0s"

    def test_seconds_only(self):
        assert format_duration(42) == "42s"

    def test_minutes_and_seconds(self):
        assert format_duration(342) == "5m 42s"

    def test_minutes_only(self):
        assert format_duration(300) == "5m"

    def test_hours_minutes_seconds(self):
        assert format_duration(3942) == "1h 5m 42s"

    def test_hours_only(self):
        assert format_duration(7200) == "2h"

    def test_hours_and_minutes_no_seconds(self):
        assert format_duration(3900) == "1h 5m"

    def test_hours_and_seconds_no_minutes(self):
        assert format_duration(3602) == "1h 2s"

    def test_fractional_truncated(self):
        assert format_duration(342.9) == "5m 42s"
