"""Unit tests for fixtures.load — the agent's QA_FIXTURES ingest (US-048).

A project's fixture files reach the agent as a JSON array of absolute paths in
`QA_FIXTURES`, and that list becomes `Agent(available_file_paths=…)`. browser-use
gates `upload_file` on exact membership of it (tools/service.py:865) and gates
`read_file`'s external reads on the same list (:1785) — so the list is the only
thing between an agent that can be argued into calling either and the contents
of the container. Pure stdlib — no browser, IMAP or network — like secret_vars
and navigation_policy.

Correctness-critical (project fixtures row in backlog/correctness-critical.md).

The direction of failure is the thing to hold on to here, because it is the
OPPOSITE of navigation_policy's and the same as secret_vars':

  * navigation_policy fails CLOSED by RAISING, because it cannot express "allow
    nothing" — browser-use reads an empty `allowed_domains` as falsy and skips
    the check entirely, so `[]` there means "allow everything".
  * fixtures fails closed by returning `[]`, because `[]` genuinely IS "allow
    nothing" for `available_file_paths`: the membership test is `path not in
    list`, which no path passes against an empty one.

So an unreadable QA_FIXTURES must resolve to `[]` and let the run proceed — the
agent is then merely unable to attach anything, which is a flow that does not
work rather than a boundary that is not there. Raising would take down a run for
a feature it may not even use.
"""
import fixtures


class TestLoad:
    def test_parses_a_json_array_of_paths(self, tmp_path):
        cv = tmp_path / "cv.pdf"
        cv.write_bytes(b"%PDF-1.4\n")
        assert fixtures.load({"QA_FIXTURES": f'["{cv}"]'}) == [str(cv)]

    def test_missing_env_is_empty(self):
        # An agent spawned by anything that forgot the variable attaches
        # nothing. Not an error: uploads are a feature most runs never touch.
        assert fixtures.load({}) == []

    def test_empty_env_is_empty(self):
        assert fixtures.load({"QA_FIXTURES": ""}) == []

    def test_empty_array_is_empty(self):
        # The deliberate "this project has no fixtures" statement the server
        # always sends (D11). Distinguishable from absent on the wire, and the
        # same answer here — which is the point of asserting both.
        assert fixtures.load({"QA_FIXTURES": "[]"}) == []

    def test_malformed_json_is_empty_not_crash(self):
        assert fixtures.load({"QA_FIXTURES": "[not json"}) == []

    def test_non_list_is_empty(self):
        for raw in ('{"cv": "/tmp/cv.pdf"}', '"/tmp/cv.pdf"', "42", "null"):
            assert fixtures.load({"QA_FIXTURES": raw}) == []


class TestWhatIsDropped:
    """Every drop below is a path the agent must NOT be told it may open."""

    def test_non_string_entries_are_dropped(self, tmp_path):
        cv = tmp_path / "cv.pdf"
        cv.write_bytes(b"x")
        raw = f'["{cv}", 42, null, ["nested"], {{"a": 1}}]'
        assert fixtures.load({"QA_FIXTURES": raw}) == [str(cv)]

    def test_relative_paths_are_dropped(self, tmp_path):
        # browser-use compares the agent's requested path to this list as an
        # exact string, and the agent's working directory is not ours. A
        # relative entry can never match the thing it was meant to permit, and
        # would resolve against the wrong root if anything ever did resolve it.
        cv = tmp_path / "cv.pdf"
        cv.write_bytes(b"x")
        raw = f'["cv.pdf", "./cv.pdf", "../cv.pdf", "{cv}"]'
        assert fixtures.load({"QA_FIXTURES": raw}) == [str(cv)]

    def test_paths_that_do_not_exist_are_dropped(self, tmp_path):
        # The whitelist must not advertise a file that is not there: browser-use
        # would accept the membership check and then fail inside the action with
        # "the file may not have been saved correctly", which reads to the user
        # as the agent being broken rather than the fixture being gone.
        cv = tmp_path / "cv.pdf"
        cv.write_bytes(b"x")
        raw = f'["{tmp_path / "ghost.pdf"}", "{cv}"]'
        assert fixtures.load({"QA_FIXTURES": raw}) == [str(cv)]

    def test_directories_are_dropped(self, tmp_path):
        # A directory in the list permits nothing (the membership test is exact,
        # so no child of it matches) but it does make `read_file` try, and an
        # entry that can only ever fail belongs nowhere near a security list.
        sub = tmp_path / "sub"
        sub.mkdir()
        assert fixtures.load({"QA_FIXTURES": f'["{sub}"]'}) == []

    def test_empty_and_whitespace_entries_are_dropped(self):
        assert fixtures.load({"QA_FIXTURES": '["", "   "]'}) == []

    def test_order_is_preserved_and_duplicates_collapse(self, tmp_path):
        a = tmp_path / "a.pdf"
        b = tmp_path / "b.pdf"
        a.write_bytes(b"a")
        b.write_bytes(b"b")
        raw = f'["{b}", "{a}", "{b}"]'
        assert fixtures.load({"QA_FIXTURES": raw}) == [str(b), str(a)]


class TestTaskNote:
    """The sentence appended to the task, naming what may be attached.

    browser-use already injects the raw paths into the prompt as
    `<available_file_paths>` (agent/prompts.py:344). That block is a list of
    absolute paths and nothing else, so a goal that says "upload my CV" leaves
    the model to infer which path is a CV from a directory named after a uuid.
    The note closes that gap by pairing each filename with its path — and does
    no more than that. US-048: "Deliberately keep this dumb — no templating, no
    generation."
    """

    def test_empty_list_adds_nothing(self):
        # No fixtures must mean no extra instructions at all, or every ad-hoc
        # run pays for a feature it is not using.
        assert fixtures.task_note([]) == ""

    def test_names_each_file_and_its_path(self, tmp_path):
        cv = tmp_path / "cv.pdf"
        note = fixtures.task_note([str(cv)])
        assert "cv.pdf" in note
        assert str(cv) in note

    def test_does_not_instruct_the_agent_to_upload(self, tmp_path):
        # The goal decides whether anything is uploaded. A note that says "use
        # these files" turns every run in a project with fixtures into a run
        # that tries to attach one.
        note = fixtures.task_note([str(tmp_path / "cv.pdf")])
        assert "must" not in note.lower()
