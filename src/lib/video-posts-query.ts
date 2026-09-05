/**
 * Builds the parameterized HAFSQL query + bind params for a page of video
 * posts. Pure (no DB access) so it's unit-testable on its own.
 * `author` is always bound, even when empty — `@author = '' OR c.author =
 * @author` keeps the WHERE clause shape identical (and pagination untouched)
 * whether or not the caller is filtering by author.
 */
export function buildVideoPostsQuery(
  community: string,
  parentPermlink: string,
  author: string,
  limit: number,
  offset: number,
): { query: string; params: { name: string; value: any }[] } {
  const tagFilter = `{"tags": ["${community}"]}`;

  const query = `
    SELECT
      c.body, c.author, c.permlink, c.title,
      c.created, c.json_metadata AS post_json_metadata,
      c.pending_payout_value, c.total_payout_value,
      (
        SELECT COUNT(*)
        FROM comments ch
        WHERE ch.parent_author = c.author
          AND ch.parent_permlink = c.permlink
          AND ch.deleted = false
      ) AS children,
      COALESCE(
        json_agg(
          json_build_object(
            'voter', v.voter,
            'weight', v.weight,
            'rshares', v.rshares
          )
        ) FILTER (WHERE v.id IS NOT NULL),
        '[]'
      ) AS votes
    FROM comments c
    LEFT JOIN operation_effective_comment_vote_view v
      ON c.author = v.author
      AND c.permlink = v.permlink
    WHERE
      (
        (
          c.parent_author = 'peak.snaps'
          AND c.parent_permlink SIMILAR TO 'snap-container-%'
          AND c.json_metadata @> @tag_filter
        )
        OR c.parent_permlink = @parent_permlink
      )
      AND c.deleted = false
      AND (@author = '' OR c.author = @author)
    GROUP BY
      c.body, c.author, c.permlink, c.title, c.created,
      c.json_metadata, c.pending_payout_value, c.total_payout_value
    ORDER BY c.created DESC
    LIMIT @limit
    OFFSET @offset;
  `;

  return {
    query,
    params: [
      { name: 'tag_filter', value: tagFilter },
      { name: 'parent_permlink', value: parentPermlink },
      { name: 'author', value: author },
      { name: 'limit', value: limit },
      { name: 'offset', value: offset },
    ],
  };
}
