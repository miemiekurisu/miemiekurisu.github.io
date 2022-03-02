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
     val groupRdd = sc.parallelize(Seq((1,2),(3,4),(5,6),(1,5),(3,8)))
     val shuffRDD = groupRdd.groupByKey()
     shuffRDD.collect
```

挑了一个会产生`ShuffledRDD`的`groupByKey` 函数，这个函数在 `PairRDDFunctions` 里，在 `RDD` 本身代码里是找不到的。

顺便提一下这个 `PairRDDFunctions`，签名是这样的：

```scala
    class PairRDDFunctions[K, V](self: RDD[(K, V)])
    (implicit kt: ClassTag[K], vt: ClassTag[V], ord: Ordering[K] = null)
  extends Logging with Serializable
```

这里用了scala的隐式转换，把RDD转换为一个`PairRDDFunctions`，
隐含的参数是pairRDD中包含的key和value的ClassTag，由于不确定RDD中key和value的类型，
采用了常见的隐式参数保留运行时类型信息。(看不明白的补一下`ClassTag`)

把RDD转换为 `PairRDDFunctions`的隐式转换方法在spark 1.3之前需要 `import SparkContext._`,
1.3之后挪到了RDD的 `rddToPairRDDFunctions` 方法里。

在[上一节](/spark/rdd/#createPCR)，我们已经看到 `groupRdd` 是个 `ParallelCollectionRDD`，
接下来我们看看产生shuffRDD的`groupByKey`函数：

```scala
    def groupByKey(partitioner: Partitioner): RDD[(K, Iterable[V])] = self.withScope {
    // groupByKey shouldn't use map side combine because map side combine does not
    // reduce the amount of data shuffled and requires all map side data be inserted
    // into a hash table, leading to more objects in the old gen.
    val createCombiner = (v: V) => CompactBuffer(v)
    val mergeValue = (buf: CompactBuffer[V], v: V) => buf += v
    val mergeCombiners = (c1: CompactBuffer[V], c2: CompactBuffer[V]) => c1 ++= c2
    val bufs = combineByKeyWithClassTag[CompactBuffer[V]](
      createCombiner, mergeValue, mergeCombiners, partitioner, mapSideCombine = false)
    bufs.asInstanceOf[RDD[(K, Iterable[V])]]
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
    // 检查一下key不能是array，为啥？请参考底下链接发挥想象力
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