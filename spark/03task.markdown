---
permalink: /spark/task
layout: default
---

## 任务执行过程

问题：
 - 一个Spark任务究竟是怎么执行的？

### 一个Spark任务究竟是怎么执行的

老实说，我不知道从哪里开始，
考虑到一般Spark程序通过 `spark-submit` 或 `spark-shell` 提交之后，
最终其实只会以 `write` 和 `collect` 进行实际执行，所以就从这2个函数入手。

`write`可能会比较复杂，涉及到实际存储，所以只是为了搞清楚执行过程，
还是从 `collect` 方法会比较简单。

所以我决定从一段简单的REPL代码入手：

```scala
     val firstRdd = sc.parallelize(Seq((1,2),(3,4),(5,6)))
     val secondRdd = sc.parallelize(Seq((1,'a'),(3,'b'),(5,'c')))
     firstRdd.join(secondRdd).collect
```

特意挑了一个 `join` 函数，这个函数在 `PairRDDFunctions` 里，在 `RDD` 本身代码里是找不到的。

顺便提一下这个 `PairRDDFunctions`，签名是这样的：

```scala
    class PairRDDFunctions[K, V](self: RDD[(K, V)])
    (implicit kt: ClassTag[K], vt: ClassTag[V], ord: Ordering[K] = null)
  extends Logging with Serializable
```

这里用了scala的隐式转换，把RDD转换为一个`PairRDDFunctions`，
隐含的参数是pairRDD中包含的key和value的ClassTag，由于不确定RDD的类型，
采用了常见的隐式参数保留运行时类型信息。(看不明白的补一下ClassTag)

在[上一节](/spark/rdd/#createPCR)，我们已经看到 `firstRdd` 和 `secondRdd` 创建的是 `ParallelCollectionRDD`，
我们先看看`join`函数：

```scala
      /**
   * Return an RDD containing all pairs of elements with matching keys in `this` and `other`. Each
   * pair of elements will be returned as a (k, (v1, v2)) tuple, where (k, v1) is in `this` and
   * (k, v2) is in `other`. Uses the given Partitioner to partition the output RDD.
   */
  def join[W](other: RDD[(K, W)], partitioner: Partitioner): RDD[(K, (V, W))] = self.withScope {
    this.cogroup(other, partitioner).flatMapValues( pair =>
      for (v <- pair._1.iterator; w <- pair._2.iterator) yield (v, w)
    )
  }
```

继续下到 `cogroup` 函数：

```scala
      /**
   * For each key k in `this` or `other`, return a resulting RDD that contains a tuple with the
   * list of values for that key in `this` as well as `other`.
   */

  def cogroup[W](other: RDD[(K, W)], partitioner: Partitioner)
      : RDD[(K, (Iterable[V], Iterable[W]))] = self.withScope {
    // 检查一下key不能是array，为啥？请参考底下链接
    if (partitioner.isInstanceOf[HashPartitioner] && keyClass.isArray) {
      throw new SparkException("HashPartitioner cannot partition array keys.")
    }
    val cg = new CoGroupedRDD[K](Seq(self, other), partitioner)
    cg.mapValues { case Array(vs, w1s) =>
      (vs.asInstanceOf[Iterable[V]], w1s.asInstanceOf[Iterable[W]])
    }
  }
```


---
参考：
1. [为啥key不能是array？](https://stackoverflow.com/questions/9973596/arraylist-as-key-in-hashmap)